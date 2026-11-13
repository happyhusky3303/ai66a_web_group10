import asyncio
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ProviderFixture, SimulatedMatch
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from app.simulated_matches import get_simulated_match, simulated_fixture

from app.utils.rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["matches"])
CACHE_TTL_SECONDS = 300
FOOTBALL_DATA_URL = os.getenv("FOOTBALL_DATA_URL", "https://api.football-data.org/v4/matches")
_cache_lock = asyncio.Lock()
_cached_matches: list[dict[str, Any]] | None = None
_cache_expires_at = 0.0
_cache_fetched_at: float | None = None

# Automatic throttling tracking based on football-data.org response headers
_requests_available: int | None = None
_counter_reset_at: float = 0.0


def _parse_header_int(headers: httpx.Headers, *header_names: str) -> int | None:
    for name in header_names:
        raw = headers.get(name)
        if raw is not None and raw.strip().isdigit():
            return int(raw.strip())
    return None


def _normalize_match(match: dict[str, Any]) -> dict[str, Any]:
    raw_status = match.get("status", "")
    if raw_status in {"SCHEDULED", "TIMED"}:
        match_status = "Before"
    elif raw_status in {"IN_PLAY", "PAUSED", "LIVE", "1H", "2H", "HT", "ET", "P"}:
        match_status = "Ongoing"
    elif raw_status in {"FINISHED", "AWARDED"}:
        match_status = "Ended"
    else:
        match_status = "Unavailable"

    score = match.get("score") or {}
    full_time = score.get("fullTime") or {}
    winner = score.get("winner")
    actual_winner = {"HOME_TEAM": "home", "AWAY_TEAM": "away", "DRAW": "draw"}.get(winner)
    return {
        "id": str(match.get("id", "")),
        "competition": (match.get("competition") or {}).get("name", "Football"),
        "utc_date": match.get("utcDate"),
        "status": match_status,
        "home_team": (match.get("homeTeam") or {}).get("name", "Home"),
        "away_team": (match.get("awayTeam") or {}).get("name", "Away"),
        "home_crest": (match.get("homeTeam") or {}).get("crest"),
        "away_crest": (match.get("awayTeam") or {}).get("crest"),
        "home_score": full_time.get("home"),
        "away_score": full_time.get("away"),
        "winner": actual_winner,
        "provider_data": match,
    }


def store_fixtures(db: Session, fixtures: list[dict]) -> None:
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    for fixture in sorted(fixtures, key=lambda item: item["id"]):
        raw = fixture.get("provider_data")
        if not raw or not fixture["id"].isascii() or not fixture["id"].isdigit():
            continue
        statement = insert(ProviderFixture).values(
            id=fixture["id"], payload=fixture, updated_at=raw.get("lastUpdated") or "",
        )
        db.execute(statement.on_conflict_do_update(
            index_elements=[ProviderFixture.id],
            set_={"payload": statement.excluded.payload, "updated_at": statement.excluded.updated_at},
            where=statement.excluded.updated_at >= ProviderFixture.updated_at,
        ))


def fixture_window() -> dict[str, str]:
    today = datetime.now(timezone.utc).date()
    return {
        "dateFrom": (today - timedelta(days=1)).isoformat(),
        "dateTo": (today + timedelta(days=7)).isoformat(),
    }


async def _fetch_matches() -> list[dict[str, Any]]:
    global _cached_matches, _cache_expires_at, _cache_fetched_at, _requests_available, _counter_reset_at
    api_key = os.getenv("FOOTBALL_DATA_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Match data is unavailable. Configure FOOTBALL_DATA_API_KEY to enable football-data.org.",
        )

    async with _cache_lock:
        now = time.monotonic()
        if _cached_matches is not None and now < _cache_expires_at:
            return _cached_matches

        # Proactive throttling check: If we have zero remaining requests before reset, avoid firing
        if _requests_available is not None and _requests_available <= 0 and now < _counter_reset_at:
            seconds_remaining = int(_counter_reset_at - now) + 1
            if _cached_matches is not None:
                logger.warning(
                    "football-data.org rate limit active (0 requests available). Serving cached matches for %ds.",
                    seconds_remaining,
                )
                _cache_expires_at = _counter_reset_at
                return _cached_matches
            raise HTTPException(
                status_code=429,
                detail=f"Football data provider rate limit active. Resets in {seconds_remaining} seconds.",
                headers={"Retry-After": str(seconds_remaining)},
            )

        params = fixture_window()
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    FOOTBALL_DATA_URL,
                    headers={"X-Auth-Token": api_key},
                    params=params,
                )

                # Inspect football-data.org throttling headers
                available = _parse_header_int(
                    response.headers,
                    "x-requests-available-minute",
                    "X-RequestsAvailable",
                )
                counter_reset = _parse_header_int(response.headers, "X-RequestCounter-Reset")
                client_id = response.headers.get("X-Authenticated-Client")
                api_version = response.headers.get("X-API-Version")

                logger.info(
                    "football-data.org response: status=%d, client=%s, v=%s, available=%s, reset_in=%ss",
                    response.status_code,
                    client_id,
                    api_version,
                    available,
                    counter_reset,
                )

                if available is not None:
                    _requests_available = available
                if counter_reset is not None:
                    _counter_reset_at = time.monotonic() + counter_reset

                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            reset_sec = _parse_header_int(exc.response.headers, "X-RequestCounter-Reset", "Retry-After") or 60
            _counter_reset_at = time.monotonic() + reset_sec
            _requests_available = 0

            if exc.response.status_code == 429:
                if _cached_matches is not None:
                    logger.warning(
                        "football-data.org rate limit exceeded (HTTP 429). Serving cached matches for %ds.",
                        reset_sec,
                    )
                    _cache_expires_at = time.monotonic() + max(reset_sec, 60)
                    return _cached_matches
                raise HTTPException(
                    status_code=429,
                    detail=f"Football data rate limit exceeded. Resets in {reset_sec} seconds.",
                    headers={"Retry-After": str(reset_sec)},
                ) from exc

            raise HTTPException(
                status_code=502,
                detail=f"Football data provider returned HTTP {exc.response.status_code}.",
            ) from exc
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=502, detail="Football data provider timed out.") from exc
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail="Could not reach football data provider.") from exc
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="Football data provider returned invalid JSON.") from exc

        if not isinstance(payload, dict):
            raise HTTPException(status_code=502, detail="Football data provider returned an invalid response.")
        matches = payload.get("matches")
        if not isinstance(matches, list):
            raise HTTPException(status_code=502, detail="Football data provider returned an invalid match list.")
        if any(not isinstance(match, dict) for match in matches):
            raise HTTPException(status_code=502, detail="Football data provider returned an invalid match.")

        _cached_matches = [_normalize_match(match) for match in matches]
        _cache_fetched_at = time.time()

        # Dynamic throttling: if requests remaining are low (<= 1), extend cache TTL until reset
        if _requests_available is not None and _requests_available <= 1 and _counter_reset_at > time.monotonic():
            extended_seconds = max(CACHE_TTL_SECONDS, int(_counter_reset_at - time.monotonic()) + 5)
            _cache_expires_at = time.monotonic() + extended_seconds
            logger.warning(
                "football-data.org remaining requests low (%d). Cache TTL dynamically extended to %ds.",
                _requests_available,
                extended_seconds,
            )
        else:
            _cache_expires_at = time.monotonic() + CACHE_TTL_SECONDS

        return _cached_matches


@router.get("/matches")
@limiter.limit("20/minute")
async def list_matches(request: Request, response: Response, db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    simulated = [simulated_fixture(item) for item in db.scalars(select(SimulatedMatch))]
    live_data_unavailable = False
    if os.getenv("MATCH_CENTER_FROM_DATABASE") == "1":
        window = fixture_window()
        kickoff = ProviderFixture.payload["utc_date"].as_string()
        matches = [fixture.payload for fixture in db.scalars(
            select(ProviderFixture)
            .where(kickoff >= window["dateFrom"], kickoff < window["dateTo"])
            .order_by(kickoff, ProviderFixture.id)
        )]
    else:
        try:
            matches = await asyncio.wait_for(_fetch_matches(), timeout=4) if simulated else await _fetch_matches()
        except (HTTPException, asyncio.TimeoutError):
            if not simulated:
                raise
            matches = []
            live_data_unavailable = True
        store_fixtures(db, matches)
        db.commit()
    if simulated:
        matches = sorted([*matches, *simulated], key=lambda item: (item.get("utc_date") or "", item["id"]))
    return {
        "matches": matches,
        **({"live_data_unavailable": live_data_unavailable} if simulated else {}),
        "fetched_at": _cache_fetched_at,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }


@router.get("/matches/{match_id}")
@limiter.limit("20/minute")
async def get_match(match_id: str, request: Request, response: Response, db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    if match_id.startswith("sim-"):
        simulated = get_simulated_match(db, match_id)
        if simulated is None:
            raise HTTPException(status_code=404, detail="Match was not found in the current fixtures.")
        return simulated_fixture(simulated)
    saved = db.get(ProviderFixture, match_id)
    if saved and saved.payload["status"] == "Ended":
        return saved.payload
    try:
        matches = await _fetch_matches()
    except HTTPException:
        if saved:
            return saved.payload
        raise
    match = next((item for item in matches if item["id"] == match_id), None)
    if match is None:
        if saved:
            return saved.payload
        raise HTTPException(status_code=404, detail="Match was not found.")
    store_fixtures(db, [match])
    db.commit()
    return match

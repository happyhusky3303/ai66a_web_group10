import asyncio
import os
import time
from datetime import date, timedelta
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.utils.rate_limit import limiter


router = APIRouter(prefix="/api", tags=["matches"])
CACHE_TTL_SECONDS = 300
FOOTBALL_DATA_URL = os.getenv("FOOTBALL_DATA_URL", "https://api.football-data.org/v4/matches")
_cache_lock = asyncio.Lock()
_cached_matches: list[dict[str, Any]] | None = None
_cache_expires_at = 0.0
_cache_fetched_at: float | None = None


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
        "home_score": full_time.get("home"),
        "away_score": full_time.get("away"),
        "winner": actual_winner,
    }


async def _fetch_matches() -> list[dict[str, Any]]:
    global _cached_matches, _cache_expires_at, _cache_fetched_at
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

        params = {
            "dateFrom": (date.today() - timedelta(days=1)).isoformat(),
            "dateTo": (date.today() + timedelta(days=7)).isoformat(),
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    FOOTBALL_DATA_URL,
                    headers={"X-Auth-Token": api_key},
                    params=params,
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
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
        _cache_expires_at = time.monotonic() + CACHE_TTL_SECONDS
        return _cached_matches


@router.get("/matches")
@limiter.limit("20/minute")
async def list_matches(request: Request) -> dict[str, Any]:
    matches = await _fetch_matches()
    return {
        "matches": matches,
        "fetched_at": _cache_fetched_at,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }
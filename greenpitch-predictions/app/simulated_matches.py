from datetime import datetime, timezone
from urllib.parse import urlsplit

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import SimulatedMatch


def simulated_match_id(public_id: str) -> int | None:
    number = public_id.removeprefix("sim-")
    if not public_id.startswith("sim-") or not number.isascii() or not number.isdecimal() or len(number) > 10:
        return None
    match_id = int(number)
    if match_id > 2_147_483_647 or public_id != f"sim-{match_id}":
        return None
    return match_id


def get_simulated_match(db: Session, public_id: str, *, lock: bool = False) -> SimulatedMatch | None:
    match_id = simulated_match_id(public_id)
    if match_id is None:
        return None
    query = select(SimulatedMatch).where(SimulatedMatch.id == match_id)
    if lock:
        if db.get_bind().dialect.name == "sqlite":
            # Acquire the SQLite write lock before reading fixture state.
            db.execute(update(SimulatedMatch).where(SimulatedMatch.id == match_id).values(id=SimulatedMatch.id))
        else:
            query = query.with_for_update()
    return db.scalar(query)


def kickoff_utc(match: SimulatedMatch) -> datetime:
    if match.kickoff.tzinfo is None:
        return match.kickoff.replace(tzinfo=timezone.utc)
    return match.kickoff.astimezone(timezone.utc)


def detail_object(details: dict, key: str) -> dict:
    value = details.get(key)
    return value if isinstance(value, dict) else {}


def image_url(value: object) -> str | None:
    if isinstance(value, str) and len(value) <= 512:
        try:
            url = urlsplit(value)
        except ValueError:
            return None
        if url.scheme in {"http", "https"} and url.hostname and url.username is None:
            return value
    return None


def simulated_fixture(match: SimulatedMatch) -> dict:
    kickoff = kickoff_utc(match)
    winner = None
    if match.finalized_at is not None:
        status = "Ended"
        winner = "draw"
        if match.home_score > match.away_score:
            winner = "home"
        elif match.away_score > match.home_score:
            winner = "away"
    elif match.status_override == "ongoing":
        status = "Ongoing"
    else:
        status = "Before" if kickoff > datetime.now(timezone.utc) else "Awaiting result"

    details = match.details or {}
    home = detail_object(details, "homeTeam")
    away = detail_object(details, "awayTeam")
    competition = detail_object(details, "competition")
    score = detail_object(details, "score")
    home_crest = image_url(home.get("crest"))
    away_crest = image_url(away.get("crest"))
    public_id = f"sim-{match.id}"
    provider_score = {
        **score,
        "winner": {"home": "HOME_TEAM", "away": "AWAY_TEAM", "draw": "DRAW"}.get(winner),
        "fullTime": {"home": match.home_score if winner else None, "away": match.away_score if winner else None},
    }
    provider_score.pop("current", None)
    if status == "Ongoing":
        provider_score["current"] = {"home": match.home_score, "away": match.away_score}
    return {
        "id": public_id,
        "source": "simulated",
        "competition": match.competition,
        "utc_date": kickoff.isoformat(),
        "status": status,
        "home_team": match.home_team,
        "away_team": match.away_team,
        "home_crest": home_crest,
        "away_crest": away_crest,
        "home_score": match.home_score,
        "away_score": match.away_score,
        "winner": winner,
        "provider_data": {
            **details,
            "id": public_id,
            "utcDate": kickoff.isoformat(),
            "status": {"Before": "SCHEDULED", "Ongoing": "IN_PLAY", "Ended": "FINISHED"}.get(status, "Awaiting result"),
            "competition": {**competition, "name": match.competition, "emblem": image_url(competition.get("emblem"))},
            "homeTeam": {**home, "name": match.home_team, "crest": home_crest},
            "awayTeam": {**away, "name": match.away_team, "crest": away_crest},
            "score": provider_score,
        },
    }

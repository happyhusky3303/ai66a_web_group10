from datetime import datetime, timezone

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
    else:
        status = "Before" if kickoff > datetime.now(timezone.utc) else "Awaiting result"
    return {
        "id": f"sim-{match.id}",
        "source": "simulated",
        "competition": match.competition,
        "utc_date": kickoff.isoformat(),
        "status": status,
        "home_team": match.home_team,
        "away_team": match.away_team,
        "home_crest": None,
        "away_crest": None,
        "home_score": match.home_score,
        "away_score": match.away_score,
        "winner": winner,
        "provider_data": {},
    }

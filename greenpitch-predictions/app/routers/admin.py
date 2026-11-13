import json
import secrets
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, field_validator
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import PointsEvent, AdminUserChange, Prediction, SimulatedMatch, User
from app.routers.auth import get_current_user
from app.routers.predictions import _settle_prediction
from app.simulated_matches import get_simulated_match, kickoff_utc, simulated_fixture


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admin access is required.")
    return user


def require_csrf(request: Request, token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None) -> None:
    expected = request.session.get("admin_csrf")
    if not expected or not token or not secrets.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(403, "Refresh the admin page and try again.")


router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])
Db = Annotated[Session, Depends(get_db)]
Actor = Annotated[User, Depends(require_admin)]
mutation = [Depends(require_csrf)]
MAX_POINTS = 2_147_483_647


class AdminInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class MatchInput(AdminInput):
    home_team: str = Field(min_length=1, max_length=128)
    away_team: str = Field(min_length=1, max_length=128)
    competition: str = Field(min_length=1, max_length=128)
    kickoff: AwareDatetime
    details: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("details")
    @classmethod
    def validate_details(cls, value: dict) -> dict:
        if len(json.dumps(value, ensure_ascii=True, allow_nan=False)) > 24_000:
            raise ValueError("Optional match data is too large.")
        return value


class ScoreInput(AdminInput):
    home_score: int = Field(strict=True, ge=0, le=MAX_POINTS)
    away_score: int = Field(strict=True, ge=0, le=MAX_POINTS)


class MatchStateInput(AdminInput):
    status: Literal["upcoming", "ongoing", "ended"]
    kickoff: AwareDatetime | None = None
    home_score: int | None = Field(default=None, strict=True, ge=0, le=MAX_POINTS)
    away_score: int | None = Field(default=None, strict=True, ge=0, le=MAX_POINTS)


class ChangeInput(AdminInput):
    reason: str = Field(min_length=1, max_length=500)
    request_id: UUID


class StatusInput(ChangeInput):
    active: bool = Field(strict=True)


class PointsInput(ChangeInput):
    delta: int = Field(strict=True, ge=-MAX_POINTS, le=MAX_POINTS)
    expected_balance: int = Field(strict=True, ge=-MAX_POINTS - 1, le=MAX_POINTS)


@router.get("/simulated-matches")
def list_simulated_matches(db: Db) -> list[dict]:
    return [
        {**simulated_fixture(match), "settled_count": match.settled_count}
        for match in db.scalars(select(SimulatedMatch).order_by(SimulatedMatch.kickoff.desc(), SimulatedMatch.id.desc()))
    ]


@router.post("/simulated-matches", status_code=201, dependencies=mutation)
def publish_match(payload: MatchInput, db: Db, actor: Actor) -> dict:
    if payload.home_team.casefold() == payload.away_team.casefold():
        raise HTTPException(422, "Choose two distinct teams.")
    kickoff = payload.kickoff.astimezone(timezone.utc)
    if kickoff <= datetime.now(timezone.utc):
        raise HTTPException(422, "Kick-off must be in the future.")
    match = SimulatedMatch(**payload.model_dump(exclude={"kickoff"}), kickoff=kickoff, created_by=actor.id)
    db.add(match)
    db.commit()
    db.refresh(match)
    return simulated_fixture(match)


@router.post("/simulated-matches/{match_id}/finalize", dependencies=mutation)
def finalize_match(match_id: str, payload: ScoreInput, db: Db, actor: Actor) -> dict:
    match = lock_match(db, match_id)
    if match.finalized_at is None and match.status_override != "ongoing" and kickoff_utc(match) > datetime.now(timezone.utc):
        raise HTTPException(409, "A final score can only be entered after kick-off.")
    return settle_match(db, match, actor, payload.home_score, payload.away_score)


def lock_match(db: Session, match_id: str) -> SimulatedMatch:
    match = get_simulated_match(db, match_id, lock=True)
    if match is None:
        raise HTTPException(404, "Simulated match not found.")
    return match


@router.post("/simulated-matches/{match_id}/state", dependencies=mutation)
def update_match_state(match_id: str, payload: MatchStateInput, db: Db, actor: Actor) -> dict:
    match = lock_match(db, match_id)
    home, away = payload.home_score, payload.away_score
    if (home is None) != (away is None):
        raise HTTPException(422, "Enter both scores or leave both blank.")
    if payload.status == "ended":
        if home is None:
            raise HTTPException(422, "Enter both final scores.")
        return settle_match(db, match, actor, home, away)
    if match.finalized_at is not None:
        raise HTTPException(409, "This match has already been settled.")
    if payload.status == "upcoming":
        kickoff = payload.kickoff.astimezone(timezone.utc) if payload.kickoff else kickoff_utc(match)
        if kickoff <= datetime.now(timezone.utc):
            raise HTTPException(422, "Choose a future kick-off to mark this match Upcoming.")
        match.kickoff = kickoff
        match.status_override = None
        match.home_score = match.away_score = None
    else:
        match.status_override = "ongoing"
        match.home_score, match.away_score = home, away
    fixture = simulated_fixture(match)
    db.commit()
    return {**fixture, "settled_count": 0}


def settle_match(db: Session, match: SimulatedMatch, actor: User, home: int, away: int) -> dict:
    if match.finalized_at is not None:
        if (match.home_score, match.away_score) != (home, away):
            raise HTTPException(409, "This match already has a final score.")
        return {**simulated_fixture(match), "settled_count": match.settled_count}

    match.home_score = home
    match.away_score = away
    match.finalized_at = datetime.now(timezone.utc)
    match.status_override = None
    match.finalized_by = actor.id
    fixture = simulated_fixture(match)
    predictions = db.scalars(
        select(Prediction).where(Prediction.match_id == fixture["id"], Prediction.is_resolved.is_(False))
        .order_by(Prediction.user_id)
    ).all()
    match.settled_count = sum(_settle_prediction(db, prediction, fixture["winner"]) for prediction in predictions)
    settled_count = match.settled_count
    db.commit()
    return {**fixture, "settled_count": settled_count}


def account_summary(user: User) -> dict:
    locked_until = user.locked_until
    if locked_until is not None and locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=timezone.utc)
    return {
        "id": user.id, "username": user.username, "email": user.email, "points": user.points,
        "active": user.is_active, "locked": bool(locked_until and locked_until > datetime.now(timezone.utc)),
    }


@router.get("/users")
def list_users(
    db: Db, q: Annotated[str, Query(max_length=254)] = "",
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
) -> dict:
    size = 20
    query = select(User).where(User.is_admin.is_(False))
    if q.strip():
        term = q.strip()
        query = query.where(or_(
            User.username.icontains(term, autoescape=True),
            User.email.icontains(term, autoescape=True),
        ))
    users = db.scalars(query.order_by(User.id).offset((page - 1) * size).limit(size + 1)).all()
    return {"users": [account_summary(user) for user in users[:size]], "has_next": len(users) > size}


def change_user(db: Session, actor: User, user_id: int, action: str, payload: ChangeInput) -> dict:
    if not 0 < user_id <= MAX_POINTS:
        raise HTTPException(404, "Account not found.")
    query = select(User).where(User.id == user_id, User.is_admin.is_(False))
    if db.get_bind().dialect.name == "sqlite":
        db.execute(update(User).where(User.id == user_id, User.is_admin.is_(False)).values(id=User.id))
    else:
        query = query.with_for_update()
    user = db.scalar(query)
    if user is None:
        raise HTTPException(404, "Account not found.")

    request_id = str(payload.request_id)
    fingerprint = payload.model_dump_json(exclude={"request_id"})
    existing = db.get(AdminUserChange, request_id)
    if existing:
        if (existing.actor_id, existing.user_id, existing.action, existing.payload) != (
            actor.id, user_id, action, fingerprint,
        ):
            raise HTTPException(409, "This request ID was already used.")
        return account_summary(user)

    if isinstance(payload, PointsInput):
        before = user.points
        after = before + payload.delta
        if before != payload.expected_balance:
            raise HTTPException(409, "The balance changed. Refresh and review the adjustment.")
        if not payload.delta or after > MAX_POINTS or (payload.delta < 0 and after < 0):
            raise HTTPException(422, "Enter a nonzero adjustment within the available balance.")
        user.points = after
        db.add(PointsEvent(user_id=user.id, delta=payload.delta, kind="adjustment",
                           occurred_at=datetime.now(timezone.utc)))
    elif isinstance(payload, StatusInput):
        before = user.is_active
        after = user.is_active = payload.active
    else:
        before = {
            "failed_attempts": user.failed_login_attempts,
            "locked_until": user.locked_until.isoformat() if user.locked_until else None,
        }
        user.failed_login_attempts = 0
        user.locked_until = None
        after = {"failed_attempts": 0, "locked_until": None}

    db.add(AdminUserChange(
        request_id=request_id, actor_id=actor.id, user_id=user.id, action=action,
        reason=payload.reason, payload=fingerprint, before=json.dumps(before), after=json.dumps(after),
        created_at=datetime.now(timezone.utc),
    ))
    summary = account_summary(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "This change could not be saved. Refresh and try again.") from exc
    return summary


@router.post("/users/{user_id}/status", dependencies=mutation)
def set_user_status(user_id: int, payload: StatusInput, db: Db, actor: Actor) -> dict:
    return change_user(db, actor, user_id, "status", payload)


@router.post("/users/{user_id}/unlock", dependencies=mutation)
def unlock_user(user_id: int, payload: ChangeInput, db: Db, actor: Actor) -> dict:
    return change_user(db, actor, user_id, "unlock", payload)


@router.post("/users/{user_id}/points", dependencies=mutation)
def adjust_user_points(user_id: int, payload: PointsInput, db: Db, actor: Actor) -> dict:
    return change_user(db, actor, user_id, "points", payload)

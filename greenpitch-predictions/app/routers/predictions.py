import asyncio
import hmac
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import PointsEvent, ProviderFixture, Prediction, SimulatedMatch, User
from app.routers.auth import get_current_user
from app.routers.matches import _fetch_matches, store_fixtures
from app.simulated_matches import get_simulated_match, simulated_fixture, simulated_match_id
from app.utils.rate_limit import limiter


router = APIRouter(tags=["predictions"])
logger = logging.getLogger(__name__)
Winner = Literal["home", "away", "draw"]


class PredictionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    user_id: int | None = Field(default=None, gt=0)
    match_id: str = Field(min_length=1, max_length=128)
    predicted_winner: Winner
    stake: int = Field(gt=0, le=2_147_483_647)


class ResolveRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    match_id: str = Field(min_length=1, max_length=128)
    actual_winner: Winner


@router.get("/api/my-predictions")
@limiter.limit("30/minute")
def get_my_prediction_choices(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    match_id: str | None = None,
) -> dict:
    query = select(Prediction).where(Prediction.user_id == user.id)
    if match_id is not None:
        query = query.where(Prediction.match_id == match_id)
    choices = []
    for prediction in db.scalars(query):
        choice = {
            "match_id": prediction.match_id,
            "predicted_winner": prediction.predicted_winner,
            "stake": prediction.stake,
        }
        if match_id is not None and prediction.is_resolved:
            choice["won"] = prediction.won
            choice["net_points"] = _prediction_points(prediction, prediction.won)[1]
        choices.append(choice)
    return {"predictions": choices}


@router.post("/api/predict", status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def create_prediction(
    request: Request,
    response: Response,
    payload: PredictionRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict:
    if payload.user_id is not None and payload.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only predict for your own account.")

    if payload.match_id.startswith("sim-"):
        if user.is_admin:
            raise HTTPException(status_code=403, detail="Admins cannot predict simulated matches.")
        simulated = get_simulated_match(db, payload.match_id, lock=True)
        match = simulated_fixture(simulated) if simulated else None
    else:
        matches = await _fetch_matches()
        match = next((item for item in matches if item["id"] == payload.match_id), None)
    if match is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Match was not found in the current fixtures.")
    if match["status"] != "Before":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Predictions are only open before a match starts.")

    existing = db.scalar(
        select(Prediction).where(
            Prediction.user_id == user.id,
            Prediction.match_id == payload.match_id,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You have already predicted this match.")

    balance_update = db.execute(
        update(User)
        .where(User.id == user.id, User.points >= payload.stake)
        .values(points=User.points - payload.stake)
    )
    if balance_update.rowcount != 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your available points are insufficient for this stake.",
        )

    store_fixtures(db, [match])
    prediction = Prediction(
        user_id=user.id,
        match_id=payload.match_id,
        predicted_winner=payload.predicted_winner,
        stake=payload.stake,
        competition=match.get("competition"),
        home_team=match.get("home_team"),
        away_team=match.get("away_team"),
        home_crest=match.get("home_crest"),
        away_crest=match.get("away_crest"),
        utc_date=match.get("utc_date"),
    )
    db.add(prediction)
    db.add(PointsEvent(user_id=user.id, delta=-payload.stake, kind="stake",
                       occurred_at=datetime.now(timezone.utc)))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You have already predicted this match.") from exc
    db.refresh(prediction)
    db.refresh(user)
    return {
        "id": prediction.id,
        "match_id": prediction.match_id,
        "predicted_winner": prediction.predicted_winner,
        "stake": prediction.stake,
        "is_resolved": prediction.is_resolved,
        "user_points": user.points,
    }


def _prediction_points(prediction: Prediction, won: bool) -> tuple[int, int, int]:
    if prediction.stake is None:
        net_points = 100 if won else -100
        payout = 100 if won else 0
        balance_change = net_points
    else:
        net_points = prediction.stake if won else -prediction.stake
        payout = prediction.stake * 2 if won else 0
        balance_change = payout
    return payout, net_points, balance_change


def _settle_prediction(db: Session, prediction: Prediction, actual_winner: str) -> bool:
    won = prediction.predicted_winner == actual_winner
    result = db.execute(
        update(Prediction)
        .where(Prediction.id == prediction.id, Prediction.is_resolved.is_(False))
        .values(won=won, is_resolved=True)
    )
    if result.rowcount != 1:
        db.refresh(prediction)
        return False

    _, _, balance_change = _prediction_points(prediction, won)
    if balance_change:
        db.execute(
            update(User)
            .where(User.id == prediction.user_id)
            .values(points=User.points + balance_change)
        )
        db.add(PointsEvent(user_id=prediction.user_id, delta=balance_change,
                           kind="payout" if won else "loss", occurred_at=datetime.now(timezone.utc)))
    return True


@router.get("/api/points-history")
@limiter.limit("30/minute")
def get_points_history(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    # Read the balance and its events in one statement so a concurrent
    # adjustment cannot appear on only one side of the calculation.
    rows = db.execute(
        select(User.points, PointsEvent)
        .outerjoin(PointsEvent, (PointsEvent.user_id == User.id) & (PointsEvent.occurred_at >= cutoff))
        .where(User.id == user.id)
        .order_by(PointsEvent.id)
    ).all()
    balance = rows[0][0]
    events = [event for _, event in rows if event is not None]
    opening = balance - sum(event.delta for event in events)
    history = []
    running = opening
    for event in events:
        running += event.delta
        timestamp = event.occurred_at
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        history.append({
            "at": timestamp.isoformat(), "kind": event.kind,
            "delta": event.delta, "balance": running,
        })
    return {"balance": balance, "opening": opening, "events": history, "since": cutoff.isoformat()}


@router.get("/api/my-matches")
@limiter.limit("30/minute")
async def get_my_matches(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict:
    predictions = db.scalars(
        select(Prediction)
        .where(Prediction.user_id == user.id)
        .order_by(Prediction.id.desc())
    ).all()

    if not predictions:
        return {"predictions": [], "user_points": user.points}

    live_data_unavailable = False
    try:
        matches = []
        if any(not pred.match_id.startswith("sim-") for pred in predictions):
            matches = await asyncio.wait_for(_fetch_matches(), timeout=4)
    except (HTTPException, asyncio.TimeoutError) as exc:
        logger.warning("Live match enrichment unavailable: %s", getattr(exc, "detail", str(exc)) or "deadline exceeded")
        matches = []
        live_data_unavailable = True
    matches_by_id = {str(m["id"]): m for m in matches}
    provider_ids = {pred.match_id for pred in predictions if not pred.match_id.startswith("sim-")}
    if provider_ids:
        for fixture in db.scalars(select(ProviderFixture).where(ProviderFixture.id.in_(provider_ids))):
            matches_by_id.setdefault(fixture.id, fixture.payload)
    simulated_ids = {match_id for pred in predictions if (match_id := simulated_match_id(pred.match_id)) is not None}
    if simulated_ids:
        for item in db.scalars(select(SimulatedMatch).where(SimulatedMatch.id.in_(simulated_ids))):
            fixture = simulated_fixture(item)
            matches_by_id[fixture["id"]] = fixture

    results = []
    points_changed = False
    settlement_attempted = False

    for pred in predictions:
        match = matches_by_id.get(str(pred.match_id))

        status_val = match.get("status") if match else ("Ended" if pred.is_resolved else "Unavailable")
        competition = (match.get("competition") if match else None) or pred.competition or "Football"
        home_team = (match.get("home_team") if match else None) or pred.home_team or "Home Team"
        away_team = (match.get("away_team") if match else None) or pred.away_team or "Away Team"
        utc_date = (match.get("utc_date") if match else None) or pred.utc_date
        home_score = match.get("home_score") if match else None
        away_score = match.get("away_score") if match else None
        actual_winner = match.get("winner") if match else None
        provider_data = match.get("provider_data", {}) if match else {}
        home_crest = (provider_data.get("homeTeam") or {}).get("crest") or pred.home_crest
        away_crest = (provider_data.get("awayTeam") or {}).get("crest") or pred.away_crest

        # Backfill metadata if missing
        if match:
            if not pred.competition:
                pred.competition = match.get("competition")
                points_changed = True
            if not pred.home_team:
                pred.home_team = match.get("home_team")
                points_changed = True
            if not pred.away_team:
                pred.away_team = match.get("away_team")
                points_changed = True
            if not pred.home_crest:
                pred.home_crest = home_crest
                points_changed = points_changed or home_crest is not None
            if not pred.away_crest:
                pred.away_crest = away_crest
                points_changed = points_changed or away_crest is not None
            if not pred.utc_date:
                pred.utc_date = match.get("utc_date")
                points_changed = points_changed or match.get("utc_date") is not None

        # Auto-resolve concluded matches with official winner
        if status_val == "Ended" and actual_winner and not pred.is_resolved and not pred.match_id.startswith("sim-"):
            settlement_attempted = True
            points_changed = _settle_prediction(db, pred, actual_winner) or points_changed

        is_resolved = pred.is_resolved or (status_val == "Ended" and actual_winner is not None)
        won = pred.won if pred.is_resolved else (
            pred.predicted_winner == actual_winner if status_val == "Ended" and actual_winner else None
        )
        if is_resolved and won is not None:
            payout, net_points, _ = _prediction_points(pred, won)
        else:
            net_points = None
            payout = None

        if pred.predicted_winner == "home":
            predicted_label = "H"
            predicted_team = home_team
        elif pred.predicted_winner == "away":
            predicted_label = "A"
            predicted_team = away_team
        else:
            predicted_label = "D"
            predicted_team = "Draw"

        results.append({
            "id": pred.id,
            "match_id": pred.match_id,
            "predicted_winner": pred.predicted_winner,
            "predicted_label": predicted_label,
            "predicted_team": predicted_team,
            "is_resolved": pred.is_resolved,
            "won": won,
            "stake": pred.stake,
            "payout": payout,
            "net_points": net_points,
            "points_awarded": net_points,
            "status": status_val,
            "source": match.get("source") if match else None,
            "competition": competition,
            "home_team": home_team,
            "away_team": away_team,
            "home_crest": home_crest,
            "away_crest": away_crest,
            "utc_date": utc_date,
            "home_score": home_score,
            "away_score": away_score,
            "actual_winner": actual_winner,
        })

    if points_changed:
        db.commit()
    if settlement_attempted:
        db.refresh(user)

    return {
        "predictions": results,
        "user_points": user.points,
        "live_data_unavailable": live_data_unavailable,
    }


@router.get("/api/leaderboard")
@limiter.limit("20/minute")
def leaderboard(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    users = db.scalars(select(User).order_by(User.points.desc(), User.username.asc()).limit(50)).all()
    return {
        "leaderboard": [
            {"rank": rank, "username": user.username, "points": user.points}
            for rank, user in enumerate(users, start=1)
        ]
    }


@router.post("/admin/resolve")
async def resolve_match(
    payload: ResolveRequest,
    db: Annotated[Session, Depends(get_db)],
    admin_token: Annotated[str | None, Header(alias="X-Admin-Token")] = None,
) -> dict:
    expected_token = os.getenv("ADMIN_TOKEN")
    if not expected_token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Match resolution is not configured.")
    if admin_token is None or not hmac.compare_digest(admin_token, expected_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin token.")

    matches = await _fetch_matches()
    match = next((item for item in matches if item["id"] == payload.match_id), None)
    if match is None or match["status"] != "Ended":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only concluded matches can be resolved.")
    if match["winner"] != payload.actual_winner:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The submitted winner does not match the official result.")

    predictions = db.scalars(
        select(Prediction).where(
            Prediction.match_id == payload.match_id,
            Prediction.is_resolved.is_(False),
        )
    ).all()
    resolved_count = sum(
        _settle_prediction(db, prediction, payload.actual_winner)
        for prediction in predictions
    )

    db.commit()
    return {"match_id": payload.match_id, "resolved_predictions": resolved_count}
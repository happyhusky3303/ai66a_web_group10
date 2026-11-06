import hmac
import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Prediction, User
from app.routers.auth import get_current_user
from app.routers.matches import _fetch_matches
from app.utils.rate_limit import limiter


router = APIRouter(tags=["predictions"])
Winner = Literal["home", "away", "draw"]


class PredictionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    user_id: int | None = Field(default=None, gt=0)
    match_id: str = Field(min_length=1, max_length=128)
    predicted_winner: Winner


class ResolveRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    match_id: str = Field(min_length=1, max_length=128)
    actual_winner: Winner


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

    prediction = Prediction(
        user_id=user.id,
        match_id=payload.match_id,
        predicted_winner=payload.predicted_winner,
        competition=match.get("competition"),
        home_team=match.get("home_team"),
        away_team=match.get("away_team"),
        home_crest=match.get("home_crest"),
        away_crest=match.get("away_crest"),
        utc_date=match.get("utc_date"),
    )
    db.add(prediction)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You have already predicted this match.") from exc
    db.refresh(prediction)
    return {
        "id": prediction.id,
        "match_id": prediction.match_id,
        "predicted_winner": prediction.predicted_winner,
        "is_resolved": prediction.is_resolved,
    }


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

    matches = await _fetch_matches()
    matches_by_id = {str(m["id"]): m for m in matches}

    results = []
    points_changed = False

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
        if status_val == "Ended" and actual_winner and not pred.is_resolved:
            pred.won = (pred.predicted_winner == actual_winner)
            pred.is_resolved = True
            user.points += 100 if pred.won else -100
            points_changed = True

        if pred.is_resolved:
            points_awarded = 100 if pred.won else -100
        elif status_val == "Ended" and actual_winner:
            points_awarded = 100 if pred.predicted_winner == actual_winner else -100
        else:
            points_awarded = None

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
            "won": pred.won if pred.is_resolved else (pred.predicted_winner == actual_winner if (status_val == "Ended" and actual_winner) else None),
            "points_awarded": points_awarded,
            "status": status_val,
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

    return {
        "predictions": results,
        "user_points": user.points,
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
    for prediction in predictions:
        prediction.won = prediction.predicted_winner == payload.actual_winner
        prediction.is_resolved = True
        prediction.user.points += 100 if prediction.won else -100

    db.commit()
    return {"match_id": payload.match_id, "resolved_predictions": len(predictions)}
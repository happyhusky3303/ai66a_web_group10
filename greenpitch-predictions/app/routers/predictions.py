import hmac
import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
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


@router.get("/api/leaderboard")
@limiter.limit("20/minute")
def leaderboard(request: Request, db: Annotated[Session, Depends(get_db)]) -> dict:
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
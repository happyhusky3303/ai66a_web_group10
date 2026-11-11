from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    email: Mapped[str | None] = mapped_column(String(254), unique=True, index=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    points: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)

    predictions: Mapped[list["Prediction"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

class Prediction(Base):
    __tablename__ = "predictions"
    __table_args__ = (
        UniqueConstraint("user_id", "match_id", name="uq_prediction_user_match"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    match_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    predicted_winner: Mapped[str] = mapped_column(String(4), nullable=False)
    stake: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    won: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    competition: Mapped[str | None] = mapped_column(String(128), nullable=True)
    home_team: Mapped[str | None] = mapped_column(String(128), nullable=True)
    away_team: Mapped[str | None] = mapped_column(String(128), nullable=True)
    home_crest: Mapped[str | None] = mapped_column(String(512), nullable=True)
    away_crest: Mapped[str | None] = mapped_column(String(512), nullable=True)
    utc_date: Mapped[str | None] = mapped_column(String(64), nullable=True)

    user: Mapped[User] = relationship(back_populates="predictions")

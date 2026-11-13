from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, false
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
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    points: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)
    last_daily_reward_date: Mapped[date | None] = mapped_column(
        Date, nullable=True
    )

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


class SimulatedMatch(Base):
    __tablename__ = "simulated_matches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    home_team: Mapped[str] = mapped_column(String(128))
    away_team: Mapped[str] = mapped_column(String(128))
    competition: Mapped[str] = mapped_column(String(128))
    kickoff: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    home_score: Mapped[int | None] = mapped_column(Integer)
    away_score: Mapped[int | None] = mapped_column(Integer)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finalized_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    settled_count: Mapped[int] = mapped_column(Integer, default=0)
    status_override: Mapped[str | None] = mapped_column(String(16))
    details: Mapped[dict | None] = mapped_column(JSON)


class AdminUserChange(Base):
    __tablename__ = "admin_user_changes"

    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    reason: Mapped[str] = mapped_column(String(500))
    payload: Mapped[str] = mapped_column(String(4096))
    before: Mapped[str] = mapped_column(String(256))
    after: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PointsEvent(Base):
    __tablename__ = "points_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    delta: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProviderFixture(Base):
    __tablename__ = "provider_fixtures"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[str] = mapped_column(String(64))

import hashlib
import hmac
import os
import re
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.utils.rate_limit import limiter


router = APIRouter(prefix="/auth", tags=["authentication"])
PASSWORD_ITERATIONS = 310_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{3,32}$")


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        value = value.strip()
        if not USERNAME_PATTERN.fullmatch(value):
            raise ValueError("Use 3–32 letters, numbers, or underscores for the username.")
        return value


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    points: int


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = stored_hash.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user_id = request.session.get("user_id")
    if not isinstance(user_id, int):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Please sign in.")
    user = db.get(User, user_id)
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Please sign in.")
    return user


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def register(
    request: Request,
    credentials: Credentials,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    existing = db.scalar(select(User).where(User.username == credentials.username))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is already taken.")

    user = User(username=credentials.username, password_hash=hash_password(credentials.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is already taken.") from exc
    db.refresh(user)
    request.session.clear()
    request.session["user_id"] = user.id
    return user


@router.post("/login", response_model=UserResponse)
@limiter.limit("5/minute")
def login(
    request: Request,
    credentials: Credentials,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = db.scalar(select(User).where(User.username == credentials.username))
    if user is None or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password.")
    request.session.clear()
    request.session["user_id"] = user.id
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me")
def current_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> dict:
    user_id = request.session.get("user_id")
    user = db.get(User, user_id) if isinstance(user_id, int) else None
    if user is None:
        request.session.clear()
        return {"authenticated": False}
    return {"authenticated": True, "user": UserResponse.model_validate(user).model_dump()}
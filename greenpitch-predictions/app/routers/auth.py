import hashlib
import hmac
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.utils.rate_limit import limiter


router = APIRouter(prefix="/auth", tags=["authentication"])
PASSWORD_ITERATIONS = 310_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{3,30}$")
PASSWORD_PATTERN = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,128}$")
MAX_FAILED_LOGINS = 5
LOCK_DURATION = timedelta(minutes=15)
DAILY_REWARD_POINTS = 500


class SignupInput(BaseModel):
    username: str = Field(min_length=3, max_length=30)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        value = value.strip()
        if not USERNAME_PATTERN.fullmatch(value):
            raise ValueError("Username phải từ 3 đến 30 ký tự và chỉ gồm chữ cái, số hoặc dấu gạch dưới.")
        return value

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if not PASSWORD_PATTERN.fullmatch(value):
            raise ValueError("Mật khẩu phải từ 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.")
        return value

    @model_validator(mode="after")
    def passwords_match(self):
        if self.password != self.confirm_password:
            raise ValueError("Mật khẩu nhập lại không khớp.")
        return self


class LoginInput(BaseModel):
    username: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_identifier(cls, value: str) -> str:
        return value.strip()


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
        rounds = int(iterations)
        if algorithm != "pbkdf2_sha256" or not 1 <= rounds <= 2_000_000:
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), rounds)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def award_daily_reward(db: Session, user: User) -> bool:
    today = utc_today()
    result = db.execute(
        update(User)
        .where(
            User.id == user.id,
            (
                User.last_daily_reward_date.is_(None)
                | (User.last_daily_reward_date < today)
            ),
        )
        .values(
            points=User.points + DAILY_REWARD_POINTS,
            last_daily_reward_date=today,
        )
        .execution_options(synchronize_session=False)
    )
    claimed = result.rowcount == 1
    if claimed:
        db.commit()
    db.refresh(user)
    return claimed


def get_current_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User:
    user_id = request.session.get("user_id")
    user = db.get(User, user_id) if isinstance(user_id, int) else None
    if user is None or not user.is_active:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Please sign in.")
    award_daily_reward(db, user)
    return user


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def register(request: Request, response: Response, credentials: SignupInput,
             db: Annotated[Session, Depends(get_db)]) -> User:
    try:
        existing = db.scalar(select(User.id).where(or_(
            func.lower(User.username) == credentials.username.lower(),
            func.lower(User.email) == credentials.email.lower(),
        )))
        if existing is not None:
            username_exists = db.scalar(select(User.id).where(func.lower(User.username) == credentials.username.lower()))
            if username_exists is not None:
                raise HTTPException(status_code=409, detail={"code": "USERNAME_EXISTS", "message": "Tên tài khoản đã tồn tại.", "errors": [{"field": "username", "message": "Tên tài khoản đã tồn tại."}]})
            raise HTTPException(status_code=409, detail={"code": "EMAIL_EXISTS", "message": "Email đã được sử dụng.", "errors": [{"field": "email", "message": "Email đã được sử dụng."}]})

        user = User(username=credentials.username, email=credentials.email,
                    password_hash=hash_password(credentials.password))
        db.add(user)
        db.commit()
        db.refresh(user)
    except HTTPException:
        raise
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": "ACCOUNT_EXISTS", "message": "Tên tài khoản hoặc email đã được sử dụng."}) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail={"code": "SERVER_ERROR", "message": "Hệ thống đang gặp sự cố. Vui lòng thử lại sau."}) from exc

    request.session.clear()
    request.session["user_id"] = user.id
    return user


@router.post("/login", response_model=UserResponse)
@limiter.limit("5/minute")
def login(request: Request, response: Response, credentials: LoginInput,
          db: Annotated[Session, Depends(get_db)]) -> User:
    identifier = credentials.username.lower()
    try:
        user = db.scalar(select(User).where(or_(
            func.lower(User.username) == identifier,
            func.lower(User.email) == identifier,
        )))
        if user is None:
            # Keep the response and approximate password-check work uniform for unknown users.
            verify_password(credentials.password, "pbkdf2_sha256$310000$" + "00" * 16 + "$" + "00" * 32)
            raise HTTPException(status_code=401, detail={"code": "AUTH_FAILED", "message": "Tên đăng nhập hoặc mật khẩu không chính xác."})

        now = datetime.now(timezone.utc)
        locked_until = user.locked_until
        if locked_until is not None and locked_until.tzinfo is None:
            locked_until = locked_until.replace(tzinfo=timezone.utc)
        if locked_until is not None and locked_until > now:
            raise HTTPException(status_code=403, detail={"code": "ACCOUNT_LOCKED", "message": "Tài khoản tạm khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau 15 phút."})
        if not user.is_active:
            raise HTTPException(status_code=403, detail={"code": "ACCOUNT_DISABLED", "message": "Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên."})

        if not verify_password(credentials.password, user.password_hash):
            user.failed_login_attempts += 1
            if user.failed_login_attempts >= MAX_FAILED_LOGINS:
                user.locked_until = now + LOCK_DURATION
                user.failed_login_attempts = 0
                db.commit()
                raise HTTPException(status_code=403, detail={"code": "ACCOUNT_LOCKED", "message": "Tài khoản tạm khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau 15 phút."})
            db.commit()
            raise HTTPException(status_code=401, detail={"code": "AUTH_FAILED", "message": "Tên đăng nhập hoặc mật khẩu không chính xác."})

        user.failed_login_attempts = 0
        user.locked_until = None
        db.commit()
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail={"code": "SERVER_ERROR", "message": "Hệ thống đang gặp sự cố. Vui lòng thử lại sau."}) from exc

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
    if user is None or not user.is_active:
        request.session.clear()
        return {"authenticated": False}
    reward_claimed = award_daily_reward(db, user)
    return {
        "authenticated": True,
        "user": UserResponse.model_validate(user).model_dump(),
        "daily_reward": {
            "claimed": reward_claimed,
            "points": DAILY_REWARD_POINTS,
            "day": user.last_daily_reward_date.isoformat(),
        },
    }

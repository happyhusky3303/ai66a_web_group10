import logging
import os
import secrets
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import http_exception_handler as fastapi_http_exception_handler
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi.errors import RateLimitExceeded
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from app.database import Base, engine
from app.routers import auth, matches, predictions
from app.utils.rate_limit import limiter


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)
PROJECT_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(PROJECT_DIR / "templates"))
session_secret = os.getenv("SESSION_SECRET_KEY")
if not session_secret:
    session_secret = secrets.token_urlsafe(32)
    logger.warning("SESSION_SECRET_KEY is unset; sessions will expire when the app restarts.")


from sqlalchemy import inspect, text

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        existing_columns = {
            column["name"] for column in inspect(conn).get_columns("predictions")
        }
        for col, col_type in [
            ("competition", "VARCHAR(128)"),
            ("home_team", "VARCHAR(128)"),
            ("away_team", "VARCHAR(128)"),
            ("home_crest", "VARCHAR(512)"),
            ("away_crest", "VARCHAR(512)"),
            ("utc_date", "VARCHAR(64)"),
            ("stake", "INTEGER"),
        ]:
            if col not in existing_columns:
                conn.execute(text(f"ALTER TABLE predictions ADD COLUMN {col} {col_type}"))
                existing_columns.add(col)
    with engine.begin() as conn:
        existing_columns = {column["name"] for column in inspect(conn).get_columns("users")}
        datetime_type = "TIMESTAMP WITH TIME ZONE" if engine.dialect.name == "postgresql" else "DATETIME"
        for col, col_type in [
            ("email", "VARCHAR(254)"),
            ("failed_login_attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("locked_until", datetime_type),
            ("is_active", "BOOLEAN NOT NULL DEFAULT TRUE"),
            ("last_daily_reward_date", "DATE"),
        ]:
            if col not in existing_columns:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} {col_type}"))
        # Legacy accounts have no email yet; new registrations use normalized unique emails.
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)"))
    yield


app = FastAPI(title="GreenPitch Predictions", lifespan=lifespan)
app.state.limiter = limiter


def add_rate_limit_headers(request: Request, response: Response) -> Response:
    current_limit = getattr(request.state, "view_rate_limit", None)
    if current_limit is not None:
        return request.app.state.limiter._inject_headers(response, current_limit)
    return response


def rate_limit_exceeded_handler(request: Request, _: RateLimitExceeded) -> Response:
    detail = (
        "No predictions available right now. Please wait for the counter to reset."
        if request.url.path == "/api/predict"
        else "Too many requests. Please try again later."
    )
    if request.url.path.startswith("/auth/"):
        response = JSONResponse(status_code=429, content={
            "success": False,
            "code": "TOO_MANY_REQUESTS",
            "message": "Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
            "errors": [],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    else:
        response = JSONResponse(status_code=429, content={"detail": detail})
    return add_rate_limit_headers(request, response)


async def limited_http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> Response:
    response = await fastapi_http_exception_handler(request, exc)
    if request.url.path.startswith("/auth/"):
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        code = detail.get("code") or ({400: "INVALID_INPUT", 401: "AUTH_FAILED", 403: "FORBIDDEN", 409: "CONFLICT", 429: "TOO_MANY_REQUESTS"}.get(exc.status_code, "SERVER_ERROR"))
        response = JSONResponse(status_code=exc.status_code, content={
            "success": False,
            "code": code,
            "message": detail.get("message", "Yêu cầu không thể xử lý."),
            "errors": detail.get("errors", []),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, headers=dict(response.headers))
    return add_rate_limit_headers(request, response)


app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
app.add_exception_handler(StarletteHTTPException, limited_http_exception_handler)


@app.exception_handler(RequestValidationError)
async def auth_validation_error_handler(request: Request, exc: RequestValidationError) -> Response:
    if not request.url.path.startswith("/auth/"):
        from fastapi.exception_handlers import request_validation_exception_handler
        return await request_validation_exception_handler(request, exc)
    errors = []
    for issue in exc.errors():
        field = str(issue.get("loc", ["body", "input"])[-1])
        errors.append({"field": field, "message": issue.get("msg", "Dữ liệu không hợp lệ.")})
    return JSONResponse(status_code=400, content={
        "success": False,
        "code": "VALIDATION_ERROR" if request.url.path.endswith("register") else "INVALID_INPUT",
        "message": "Vui lòng kiểm tra lại thông tin đã nhập.",
        "errors": errors,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
app.add_middleware(
    SessionMiddleware,
    secret_key=session_secret,
    session_cookie="greenpitch_session",
    same_site="lax",
    https_only=os.getenv("SESSION_HTTPS_ONLY", "false").lower() == "true",
)
app.mount("/static", StaticFiles(directory=str(PROJECT_DIR / "static")), name="static")
app.include_router(auth.router)
app.include_router(matches.router)
app.include_router(predictions.router)


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/match-center", response_class=HTMLResponse, include_in_schema=False)
def match_center_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="match_center.html")


@app.get("/match/{match_id}", response_class=HTMLResponse, include_in_schema=False)
def match_detail_page(request: Request, match_id: str) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="match_detail.html")


@app.get("/login", response_class=HTMLResponse, include_in_schema=False)
def login_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="login.html")


@app.get("/my-matches", response_class=HTMLResponse, include_in_schema=False)
def my_matches_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="my_matches.html")

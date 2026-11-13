import asyncio
import sys
from hashlib import sha256
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import http_exception_handler as fastapi_http_exception_handler
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.models import User
from app.routers import admin, auth, matches, predictions


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)
PROJECT_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(PROJECT_DIR / "templates"))
templates.env.globals["asset_version"] = sha256(
    (PROJECT_DIR / "static/js/app.js").read_bytes()
    + (PROJECT_DIR / "static/css/style.css").read_bytes()
    + (PROJECT_DIR / "static/js/admin.js").read_bytes()
).hexdigest()[:12]
session_secret = os.getenv("SESSION_SECRET_KEY")
if not session_secret:
    session_secret = secrets.token_urlsafe(32)
    logger.warning("SESSION_SECRET_KEY is unset; sessions will expire when the app restarts.")


from sqlalchemy import inspect, select, text, update

async def run_fixture_job(mode: str) -> None:
    while True:
        status = None
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "app.reconcile_fixtures", mode, "--apply",
            )
            try:
                status = await process.wait()
            except asyncio.CancelledError:
                if process.returncode is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                    await process.wait()
                raise
            if status:
                logger.warning("Fixture job %s exited with status %d", mode, status)
        except OSError:
            logger.exception("Could not start fixture job %s", mode)

        delay = 900
        if mode == "--window":
            now = datetime.now(timezone.utc)
            next_run = now.replace(hour=0, minute=5, second=0, microsecond=0)
            if next_run <= now:
                next_run += timedelta(days=1)
            delay = (next_run - now).total_seconds()
            if status != 0:
                delay = min(delay, 900)
        await asyncio.sleep(delay)


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
            ("is_admin", "BOOLEAN NOT NULL DEFAULT FALSE"),
            ("last_daily_reward_date", "DATE"),
        ]:
            if col not in existing_columns:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} {col_type}"))
        # Legacy accounts have no email yet; new registrations use normalized unique emails.
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)"))
        simulated_columns = {column["name"] for column in inspect(conn).get_columns("simulated_matches")}
        for col, col_type in [("status_override", "VARCHAR(16)"), ("details", "JSON")]:
            if col not in simulated_columns:
                conn.execute(text(f"ALTER TABLE simulated_matches ADD COLUMN {col} {col_type}"))
    bootstrap_admin()
    jobs = []
    if os.getenv("FOOTBALL_DATA_API_KEY") and os.getenv("FIXTURE_JOBS_ENABLED", "1") == "1":
        jobs = [
            asyncio.create_task(run_fixture_job(mode))
            for mode in ("--window", "--overdue")
        ]
    try:
        yield
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


def bootstrap_admin() -> None:
    username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", "").strip()
    if not username:
        return
    active_account = (User.username == username, User.is_active.is_(True))
    with engine.begin() as conn:
        result = conn.execute(
            update(User).where(*active_account, User.is_admin.is_(False)).values(is_admin=True)
        )
        account_found = result.rowcount == 1 or conn.scalar(select(User.id).where(*active_account)) is not None
    if result.rowcount == 1:
        logger.info("Granted admin access to configured account %r.", username)
    elif not account_found:
        logger.warning("Startup admin account %r was not found or is inactive.", username)


app = FastAPI(title="GreenPitch Predictions", lifespan=lifespan)


async def app_http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> Response:
    response = await fastapi_http_exception_handler(request, exc)
    if request.url.path.startswith("/auth/"):
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        code = detail.get("code") or ({400: "INVALID_INPUT", 401: "AUTH_FAILED", 403: "FORBIDDEN", 409: "CONFLICT"}.get(exc.status_code, "SERVER_ERROR"))
        response = JSONResponse(status_code=exc.status_code, content={
            "success": False,
            "code": code,
            "message": detail.get("message", "Yêu cầu không thể xử lý."),
            "errors": detail.get("errors", []),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, headers=dict(response.headers))
    return response


app.add_exception_handler(StarletteHTTPException, app_http_exception_handler)


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
app.include_router(admin.router)


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


def render_admin_page(request: Request, db: Session, page: str, title: str) -> Response:
    try:
        admin.require_admin(auth.get_current_user(request, db))
    except HTTPException as exc:
        if exc.status_code == 401:
            return RedirectResponse("/login", status_code=303)
        raise
    token = request.session.setdefault("admin_csrf", secrets.token_urlsafe(32))
    return templates.TemplateResponse(
        request=request, name="admin.html",
        context={"page": page, "title": title, "csrf_token": token},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/admin/create-match", response_class=HTMLResponse, include_in_schema=False)
def create_match_page(request: Request, db: Annotated[Session, Depends(get_db)]) -> Response:
    return render_admin_page(request, db, "create-match", "Create Match")


@app.get("/admin/users", response_class=HTMLResponse, include_in_schema=False)
def user_management_page(request: Request, db: Annotated[Session, Depends(get_db)]) -> Response:
    return render_admin_page(request, db, "users", "User Management")

from hashlib import sha256
import logging
import json
import os
import secrets
import time
from datetime import datetime, timezone
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

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.models import User
from app.observability import configure_logging, log_event, request_id_context, request_id_from
from app.routers import admin, auth, matches, predictions


configure_logging()
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


from sqlalchemy import inspect, select, update

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
    log_event(logger, logging.INFO, "application.started", database_dialect=engine.dialect.name)
    yield
    log_event(logger, logging.INFO, "application.stopped")


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


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next) -> Response:
    request_id = request_id_from(request.headers.get("X-Request-ID"))
    request.state.request_id = request_id
    token = request_id_context.set(request_id)
    started = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        route = request.scope.get("route")
        log_event(
            logger,
            logging.WARNING if status_code >= 500 else logging.INFO,
            "http.request.completed",
            method=request.method,
            route=getattr(route, "path", request.url.path),
            status_code=status_code,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
        )
        request_id_context.reset(token)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    request_id = getattr(request.state, "request_id", "-")
    token = request_id_context.set(request_id)
    try:
        logger.exception(
            "Unhandled request exception",
            extra={"event_fields": {
                "event": "http.request.unhandled_exception",
                "method": request.method,
                "route": getattr(request.scope.get("route"), "path", request.url.path),
                "exception_type": type(exc).__name__,
            }},
        )
    finally:
        request_id_context.reset(token)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred.", "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.get("/health/live", include_in_schema=False)
def liveness() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", include_in_schema=False)
def readiness() -> Response:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        logger.exception("Database readiness check failed")
        return JSONResponse(status_code=503, content={"status": "not_ready"})
    return JSONResponse(content={"status": "ready"})


async def app_http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> Response:
    response = await fastapi_http_exception_handler(request, exc)
    route_path = getattr(request.scope.get("route"), "path", request.url.path)
    detail_code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
    log_event(
        logger,
        logging.WARNING if exc.status_code >= 500 else logging.INFO,
        "http.request.rejected",
        method=request.method,
        route=route_path,
        status_code=exc.status_code,
        error_code=detail_code,
    )
    if request.url.path.startswith("/auth/"):
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        code = detail.get("code") or ({400: "INVALID_INPUT", 401: "AUTH_FAILED", 403: "FORBIDDEN", 409: "CONFLICT"}.get(exc.status_code, "SERVER_ERROR"))
        response = JSONResponse(status_code=exc.status_code, content={
            "success": False,
            "code": code,
            "message": detail.get("message", "Yêu cầu không thể xử lý."),
            "errors": detail.get("errors", []),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "request_id": getattr(request.state, "request_id", "-"),
        }, headers=dict(response.headers))
    else:
        try:
            body = json.loads(response.body)
            if isinstance(body, dict):
                body["request_id"] = getattr(request.state, "request_id", "-")
                response = JSONResponse(status_code=exc.status_code, content=body, headers=dict(response.headers))
        except (TypeError, ValueError):
            pass
    return response


app.add_exception_handler(StarletteHTTPException, app_http_exception_handler)


@app.exception_handler(RequestValidationError)
async def auth_validation_error_handler(request: Request, exc: RequestValidationError) -> Response:
    if not request.url.path.startswith("/auth/"):
        from fastapi.exception_handlers import request_validation_exception_handler
        issues = exc.errors()
        log_event(logger, logging.INFO, "http.request.validation_failed",
                  method=request.method,
                  route=getattr(request.scope.get("route"), "path", request.url.path),
                  error_count=len(issues),
                  fields=sorted({str(issue.get("loc", ["input"])[-1]) for issue in issues}))
        response = await request_validation_exception_handler(request, exc)
        try:
            body = json.loads(response.body)
            if isinstance(body, dict):
                body["request_id"] = getattr(request.state, "request_id", "-")
                return JSONResponse(status_code=response.status_code, content=body, headers=dict(response.headers))
        except (TypeError, ValueError):
            pass
        return response
    errors = []
    for issue in exc.errors():
        field = str(issue.get("loc", ["body", "input"])[-1])
        errors.append({"field": field, "message": issue.get("msg", "Dữ liệu không hợp lệ.")})
    log_event(logger, logging.INFO, "http.request.validation_failed",
              method=request.method, route=getattr(request.scope.get("route"), "path", request.url.path),
              error_count=len(errors), fields=sorted({item["field"] for item in errors}))
    return JSONResponse(status_code=400, content={
        "success": False,
        "code": "VALIDATION_ERROR" if request.url.path.endswith("register") else "INVALID_INPUT",
        "message": "Vui lòng kiểm tra lại thông tin đã nhập.",
        "errors": errors,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "request_id": getattr(request.state, "request_id", "-"),
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

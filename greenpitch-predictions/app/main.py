import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi.errors import RateLimitExceeded
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


from sqlalchemy import text

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        for col, col_type in [
            ("competition", "VARCHAR(128)"),
            ("home_team", "VARCHAR(128)"),
            ("away_team", "VARCHAR(128)"),
            ("utc_date", "VARCHAR(64)"),
        ]:
            try:
                conn.execute(text(f"ALTER TABLE predictions ADD COLUMN {col} {col_type}"))
                conn.commit()
            except Exception:
                pass
    yield


app = FastAPI(title="GreenPitch Predictions", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda request, exc: JSONResponse(
    status_code=429,
    content={"detail": "Too many requests. Please try again later."},
))
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


@app.get("/login", response_class=HTMLResponse, include_in_schema=False)
def login_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="login.html")


@app.get("/my-matches", response_class=HTMLResponse, include_in_schema=False)
def my_matches_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name="my_matches.html")
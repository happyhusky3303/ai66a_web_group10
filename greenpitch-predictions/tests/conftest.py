import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import database, main
from app.routers import matches
from app.utils.rate_limit import limiter


@pytest.fixture(autouse=True)
def reset_shared_state():
    matches._cached_matches = None
    matches._cache_expires_at = 0.0
    matches._cache_fetched_at = None
    matches._requests_available = None
    matches._counter_reset_at = 0.0
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(
        database,
        "SessionLocal",
        sessionmaker(autocommit=False, autoflush=False, bind=engine),
    )
    monkeypatch.setenv("ADMIN_TOKEN", "test-admin-token")

    try:
        with TestClient(main.app) as test_client:
            yield test_client
    finally:
        engine.dispose()

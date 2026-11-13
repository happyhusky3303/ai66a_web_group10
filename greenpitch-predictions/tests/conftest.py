import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import database, main
from app.routers import matches


@pytest.fixture(autouse=True)
def reset_shared_state():
    matches._cached_matches = None
    matches._cache_expires_at = 0.0
    matches._cache_fetched_at = None


@pytest.fixture
def client(tmp_path, monkeypatch):
    postgres_url = os.getenv("GREENPITCH_TEST_POSTGRES_URL")
    if postgres_url:
        schema = f"test_{uuid4().hex}"
        bootstrap = create_engine(postgres_url)
        with bootstrap.begin() as conn:
            conn.execute(text(f"CREATE SCHEMA {schema}"))
        engine = create_engine(postgres_url, connect_args={"options": f"-c search_path={schema}"})
    else:
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
        if postgres_url:
            with bootstrap.begin() as conn:
                conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
            bootstrap.dispose()

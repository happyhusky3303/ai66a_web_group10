from datetime import timedelta

import pytest
from sqlalchemy import select

from app import database
from app.models import User
from app.routers import auth
from app.routers.auth import hash_password, verify_password


def signup_payload(username):
    return {
        "username": username,
        "email": f"{username}@example.com",
        "password": "Valid-password1!",
        "confirm_password": "Valid-password1!",
    }


def test_registration_creates_user_and_authenticates_session(client):
    response = client.post(
        "/auth/register",
        json={**signup_payload("green_pitch"), "username": "  green_pitch  "},
    )

    assert response.status_code == 201
    assert response.json()["username"] == "green_pitch"
    assert response.json()["points"] == 1000
    assert "greenpitch_session" in response.cookies
    current = client.get("/auth/me").json()
    assert current == {
        "authenticated": True,
        "is_admin": False,
        "user": response.json(),
        "daily_reward": {
            "claimed": False,
            "points": 500,
            "day": auth.utc_today().isoformat(),
        },
    }

    with database.SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "green_pitch"))
        assert user is not None
        assert user.password_hash != "Valid-password1!"
        assert verify_password("Valid-password1!", user.password_hash)
        assert user.points == 1000



def test_daily_gift_requires_claim_and_is_awarded_once_per_utc_day(client, monkeypatch):
    assert client.post("/auth/daily-gift/claim").status_code == 401
    assert client.post("/auth/register", json=signup_payload("gift_user")).status_code == 201
    assert client.get("/api/my-predictions").status_code == 200
    current = client.get("/auth/me").json()
    assert current["user"]["points"] == 1000
    assert current["daily_reward"]["claimed"] is False

    first = client.post("/auth/daily-gift/claim").json()
    repeated = client.post("/auth/daily-gift/claim").json()
    assert first["awarded"] is True
    assert repeated["awarded"] is False
    assert first["user"]["points"] == repeated["user"]["points"] == 1500
    assert repeated["daily_reward"]["claimed"] is True
    assert client.get("/auth/me").json()["daily_reward"]["claimed"] is True

    next_day = auth.utc_today() + timedelta(days=1)
    monkeypatch.setattr(auth, "utc_today", lambda: next_day)
    available = client.get("/auth/me").json()
    assert available["daily_reward"]["claimed"] is False
    assert available["daily_reward"]["day"] == next_day.isoformat()
    assert available["user"]["points"] == 1500
    assert client.post("/auth/daily-gift/claim").json()["user"]["points"] == 2000


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("ab", "Valid-password1!"),
        ("invalid name", "Valid-password1!"),
        ("valid_user", "short"),
    ],
)
def test_registration_rejects_invalid_credentials(client, username, password):
    response = client.post(
        "/auth/register",
        json={**signup_payload("valid_user"), "username": username, "password": password, "confirm_password": password},
    )

    assert response.status_code == 400
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_duplicate_registration_is_rejected(client):
    credentials = signup_payload("green_pitch")
    assert client.post("/auth/register", json=credentials).status_code == 201

    response = client.post("/auth/register", json=credentials)

    assert response.status_code == 409


def test_login_logout_and_current_user(client):
    credentials = signup_payload("green_pitch")
    client.post("/auth/register", json=credentials)
    client.post("/auth/logout")

    login_response = client.post("/auth/login", json={"username": credentials["username"], "password": credentials["password"]})
    assert login_response.status_code == 200
    assert client.get("/auth/me").json()["authenticated"] is True

    logout_response = client.post("/auth/logout")
    assert logout_response.status_code == 204
    assert client.get("/auth/me").json() == {"authenticated": False}


def test_login_rejects_incorrect_password(client):
    client.post(
        "/auth/register",
        json=signup_payload("green_pitch"),
    )

    response = client.post(
        "/auth/login",
        json={"username": "green_pitch", "password": "wrong-password"},
    )

    assert response.status_code == 401


def test_password_hashes_use_distinct_salts_and_reject_wrong_password():
    first_hash = hash_password("valid-password")
    second_hash = hash_password("valid-password")

    assert first_hash != second_hash
    assert verify_password("valid-password", first_hash)
    assert not verify_password("wrong-password", first_hash)
    assert not verify_password("valid-password", "not-a-valid-hash")

import pytest
from sqlalchemy import select

from app import database
from app.models import User
from app.routers.auth import hash_password, verify_password


def test_registration_creates_user_and_authenticates_session(client):
    response = client.post(
        "/auth/register",
        json={"username": "  green_pitch  ", "password": "valid-password"},
    )

    assert response.status_code == 201
    assert response.json()["username"] == "green_pitch"
    assert response.json()["points"] == 1000
    assert "greenpitch_session" in response.cookies
    assert client.get("/auth/me").json() == {
        "authenticated": True,
        "user": response.json(),
    }

    with database.SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "green_pitch"))
        assert user is not None
        assert user.password_hash != "valid-password"
        assert verify_password("valid-password", user.password_hash)


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("ab", "valid-password"),
        ("invalid name", "valid-password"),
        ("valid_user", "short"),
    ],
)
def test_registration_rejects_invalid_credentials(client, username, password):
    response = client.post(
        "/auth/register",
        json={"username": username, "password": password},
    )

    assert response.status_code == 422


def test_duplicate_registration_is_rejected(client):
    credentials = {"username": "green_pitch", "password": "valid-password"}
    assert client.post("/auth/register", json=credentials).status_code == 201

    response = client.post("/auth/register", json=credentials)

    assert response.status_code == 409


def test_login_logout_and_current_user(client):
    credentials = {"username": "green_pitch", "password": "valid-password"}
    client.post("/auth/register", json=credentials)
    client.post("/auth/logout")

    login_response = client.post("/auth/login", json=credentials)
    assert login_response.status_code == 200
    assert client.get("/auth/me").json()["authenticated"] is True

    logout_response = client.post("/auth/logout")
    assert logout_response.status_code == 204
    assert client.get("/auth/me").json() == {"authenticated": False}


def test_login_rejects_incorrect_password(client):
    client.post(
        "/auth/register",
        json={"username": "green_pitch", "password": "valid-password"},
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

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app import database
from app.models import AdminUserChange, Prediction, SimulatedMatch, User
from app.routers import admin, matches
from app.routers.auth import hash_password

PASSWORD = "Valid-password1!"


@pytest.fixture
def admin_client(client):
    with database.SessionLocal.begin() as db:
        db.add(User(username="operator", email="operator@example.com", password_hash=hash_password(PASSWORD), is_admin=True))
    with TestClient(client.app) as browser:
        assert browser.post("/auth/login", json={"username": "operator", "password": PASSWORD}).status_code == 200
        page = browser.get("/admin/create-match")
        assert page.status_code == 200
        token = re.search(r'name="admin-csrf" content="([^"]+)"', page.text).group(1)
        browser.headers["X-CSRF-Token"] = token
        yield browser


def register(client, name="player", **extra):
    response = client.post("/auth/register", json={
        "username": name, "email": f"{name}@example.com", "password": PASSWORD,
        "confirm_password": PASSWORD, **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def publish(browser):
    response = browser.post("/api/admin/simulated-matches", json={
        "home_team": "Green City", "away_team": "North FC", "competition": "Test League",
        "kickoff": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def move_past_kickoff(match_id):
    with database.SessionLocal.begin() as db:
        db.execute(update(SimulatedMatch).where(SimulatedMatch.id == int(match_id[4:]))
                   .values(kickoff=datetime.now(timezone.utc) - timedelta(hours=1)))


def test_startup_promotes_only_the_configured_active_account(client, monkeypatch):
    user_id = register(client, "happyhusky")
    with database.SessionLocal.begin() as db:
        db.add(User(username="other_user", password_hash="test-only"))
    monkeypatch.setenv("BOOTSTRAP_ADMIN_USERNAME", "happyhusky")

    for _ in range(2):
        with TestClient(client.app):
            with database.SessionLocal() as db:
                user = db.get(User, user_id)
                assert user.is_admin and user.points == 1000
                assert not db.scalar(select(User).where(User.username == "other_user")).is_admin

    assert client.get("/admin/users").status_code == 200
    monkeypatch.delenv("BOOTSTRAP_ADMIN_USERNAME")
    with database.SessionLocal.begin() as db:
        db.get(User, user_id).is_admin = False
    with TestClient(client.app):
        assert client.get("/admin/users").status_code == 403


@pytest.mark.parametrize("account_exists", [False, True])
def test_startup_skips_missing_or_inactive_admin_account(client, monkeypatch, account_exists):
    if account_exists:
        with database.SessionLocal.begin() as db:
            db.add(User(username="happyhusky", password_hash="test-only", is_active=False))
    monkeypatch.setenv("BOOTSTRAP_ADMIN_USERNAME", "happyhusky")
    with TestClient(client.app):
        with database.SessionLocal() as db:
            account = db.scalar(select(User).where(User.username == "happyhusky"))
            assert not account.is_admin if account_exists else account is None


def test_existing_accounts_keep_balances_and_default_to_regular_role(client):
    user_id = register(client)
    with database.engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE users DROP COLUMN is_admin")
    with TestClient(client.app):
        with database.SessionLocal() as db:
            user = db.get(User, user_id)
            assert user.is_admin is False
            assert user.points == 1000


def test_account_search_pagination(client, admin_client):
    with database.SessionLocal.begin() as db:
        db.add_all(User(username=f"page_user_{index}", password_hash="test-only") for index in range(22))
    first = admin_client.get("/api/admin/users", params={"q": "page_user_", "page": 1}).json()
    second = admin_client.get("/api/admin/users", params={"q": "page_user_", "page": 2}).json()
    assert len(first["users"]) == 20 and first["has_next"]
    assert len(second["users"]) == 2 and not second["has_next"]
    assert first["users"][-1]["id"] < second["users"][0]["id"]


def test_admin_permissions_and_csrf(client, admin_client):
    assert client.get("/admin/users", follow_redirects=False).status_code == 303
    assert client.get("/api/admin/users").status_code == 401
    register(client, is_admin=True)
    assert client.get("/auth/me").json()["is_admin"] is False
    assert client.get("/admin/create-match").status_code == 403
    assert client.get("/admin/users").status_code == 403
    assert client.get("/api/admin/users").status_code == 403
    assert admin_client.get("/admin/users").status_code == 200
    assert admin_client.post("/api/admin/simulated-matches", headers={"X-CSRF-Token": "wrong"}, json={}).status_code == 403
    with database.SessionLocal.begin() as db:
        db.execute(update(User).where(User.username == "operator").values(is_admin=False))
    assert admin_client.get("/api/admin/users").status_code == 403


@pytest.mark.parametrize(("score", "winner"), [((2, 1), "home"), ((0, 3), "away"), ((0, 0), "draw")])
def test_simulated_matches_settle_into_shared_points(client, admin_client, monkeypatch, score, winner):
    async def provider_unavailable():
        raise HTTPException(503, "Unavailable")

    monkeypatch.setattr(matches, "_fetch_matches", provider_unavailable)
    user_id = register(client)
    match_id = publish(admin_client)
    assert client.get("/api/matches").json()["live_data_unavailable"] is True
    assert client.get("/api/matches").json()["matches"][0]["source"] == "simulated"
    assert client.get(f"/api/matches/{match_id}").json()["status"] == "Before"
    assert admin_client.post("/api/predict", json={"match_id": match_id, "predicted_winner": winner, "stake": 100}).status_code == 403
    pick = client.post("/api/predict", json={"match_id": match_id, "predicted_winner": winner, "stake": 100})
    assert pick.status_code == 201 and pick.json()["user_points"] == 900
    with TestClient(client.app) as other:
        register(other, "second_player")
        losing_pick = other.post("/api/predict", json={
            "match_id": match_id, "predicted_winner": "away" if winner == "home" else "home", "stake": 50,
        })
        assert losing_pick.status_code == 201

    path = f"/api/admin/simulated-matches/{match_id}/finalize"
    payload = {"home_score": score[0], "away_score": score[1]}
    assert admin_client.post(path, json=payload).status_code == 409
    move_past_kickoff(match_id)
    assert client.get(f"/api/matches/{match_id}").json()["status"] == "Awaiting result"
    assert client.post("/api/predict", json={"match_id": match_id, "predicted_winner": winner, "stake": 100}).status_code == 409
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: admin_client.post(path, json=payload), range(2)))
    for response in responses:
        assert response.status_code == 200, response.text
        assert response.json()["winner"] == winner
        assert response.json()["settled_count"] == 2
    assert admin_client.post(path, json={**payload, "home_score": 9}).status_code == 409
    mine = client.get("/api/my-matches").json()
    assert mine["predictions"][0]["home_score"] == score[0]
    assert mine["predictions"][0]["net_points"] == 100
    assert mine["user_points"] == 1100
    leaders = {row["username"]: row["points"] for row in client.get("/api/leaderboard").json()["leaderboard"]}
    assert leaders["player"] == 1100
    assert leaders["second_player"] == 950
    with database.SessionLocal() as db:
        assert db.get(User, user_id).points == 1100


def test_simulated_fixture_details_and_manual_state(client, admin_client):
    register(client)
    kickoff = datetime.now(timezone.utc) + timedelta(hours=1)
    response = admin_client.post("/api/admin/simulated-matches", json={
        "home_team": "Green City", "away_team": "North FC", "competition": "Test League",
        "kickoff": kickoff.isoformat(),
        "details": {
            "venue": "City Park", "matchday": 8, "status": "FINISHED",
            "homeTeam": {"name": "Override", "shortName": "City", "crest": "https://example.com/city.svg"},
            "referees": [{"name": "Test Referee"}], "score": {"fullTime": {"home": 99}, "halfTime": {"home": 0, "away": 0}},
        },
    })
    assert response.status_code == 201, response.text
    match_id = response.json()["id"]
    fixture = client.get(f"/api/matches/{match_id}").json()
    assert fixture["status"] == "Before"
    assert fixture["home_crest"] == "https://example.com/city.svg"
    assert fixture["provider_data"]["venue"] == "City Park"
    assert fixture["provider_data"]["status"] == "SCHEDULED"
    assert fixture["provider_data"]["homeTeam"]["name"] == "Green City"
    assert fixture["provider_data"]["score"]["fullTime"]["home"] is None
    assert fixture["provider_data"]["referees"][0]["name"] == "Test Referee"

    path = f"/api/admin/simulated-matches/{match_id}/state"
    pick = {"match_id": match_id, "predicted_winner": "home", "stake": 100}
    assert client.post(path, json={"status": "ongoing"}).status_code == 403
    assert admin_client.post(path, json={"status": "ongoing", "home_score": 0}).status_code == 422
    live = admin_client.post(path, json={"status": "ongoing", "home_score": 0, "away_score": 1}).json()
    assert live["status"] == "Ongoing" and live["home_score"] == 0 and live["winner"] is None
    assert client.post("/api/predict", json=pick).status_code == 409

    new_kickoff = kickoff + timedelta(hours=1)
    upcoming = admin_client.post(path, json={"status": "upcoming", "kickoff": new_kickoff.isoformat()}).json()
    assert upcoming["status"] == "Before" and upcoming["home_score"] is None
    assert upcoming["utc_date"] == new_kickoff.isoformat()
    assert client.post("/api/predict", json=pick).status_code == 201
    assert admin_client.post(path, json={"status": "ended"}).status_code == 422

    final = {"status": "ended", "home_score": 2, "away_score": 1}
    for _ in range(2):
        result = admin_client.post(path, json=final).json()
        assert result["status"] == "Ended" and result["settled_count"] == 1
    assert admin_client.post(path, json={"status": "upcoming"}).status_code == 409
    assert admin_client.post(path, json={**final, "home_score": 3}).status_code == 409
    assert client.get("/auth/me").json()["user"]["points"] == 1100


def test_existing_simulated_fixtures_survive_schema_update(client, admin_client):
    match_id = publish(admin_client)
    with database.engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE simulated_matches DROP COLUMN status_override")
        conn.exec_driver_sql("ALTER TABLE simulated_matches DROP COLUMN details")
    with TestClient(client.app):
        fixture = client.get(f"/api/matches/{match_id}").json()
        assert fixture["status"] == "Before"
        assert fixture["home_team"] == "Green City"


def test_failed_settlement_rolls_back(client, admin_client, monkeypatch):
    user_id = register(client)
    match_id = publish(admin_client)
    assert client.post("/api/predict", json={"match_id": match_id, "predicted_winner": "home", "stake": 100}).status_code == 201
    move_past_kickoff(match_id)
    settle = admin._settle_prediction

    def fail_after_payout(*args):
        settle(*args)
        raise RuntimeError("Test transaction failure")

    monkeypatch.setattr(admin, "_settle_prediction", fail_after_payout)
    with pytest.raises(RuntimeError, match="Test transaction failure"):
        admin_client.post(f"/api/admin/simulated-matches/{match_id}/finalize", json={"home_score": 1, "away_score": 0})
    assert client.get(f"/api/matches/{match_id}").json()["status"] == "Awaiting result"
    with database.SessionLocal() as db:
        assert db.get(User, user_id).points == 900
        assert db.scalar(select(Prediction)).is_resolved is False


def test_adjustment_and_daily_gift_preserve_both_updates(client, admin_client):
    user_id = register(client)
    path = f"/api/admin/users/{user_id}/points"
    payload = {"delta": 50, "expected_balance": 1000, "reason": "Support adjustment", "request_id": str(uuid4())}

    with ThreadPoolExecutor(max_workers=2) as pool:
        adjustment = pool.submit(admin_client.post, path, json=payload)
        gift = pool.submit(client.post, "/auth/daily-gift/claim")
        assert gift.result().status_code == 200
        response = adjustment.result()
    if response.status_code == 409:
        assert client.get("/auth/me").json()["user"]["points"] == 1500
        payload["expected_balance"] = 1500
        response = admin_client.post(path, json=payload)
    assert response.status_code == 200, response.text
    assert client.get("/auth/me").json()["user"]["points"] == 1550


def test_account_management_and_adjustment_audit(client, admin_client):
    user_id = register(client)
    users = admin_client.get("/api/admin/users", params={"q": "PLAYER@EXAMPLE.COM"}).json()["users"]
    assert [user["id"] for user in users] == [user_id]
    root = f"/api/admin/users/{user_id}"
    change = {"delta": 250, "expected_balance": 1000, "reason": "Correct starting points", "request_id": str(uuid4())}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: admin_client.post(root + "/points", json=change), range(2)))
    for response in responses:
        assert response.status_code == 200, response.text
        assert response.json()["points"] == 1250
    assert admin_client.post(root + "/points", json={**change, "request_id": str(uuid4())}).status_code == 409
    deduction = {**change, "delta": -1300, "expected_balance": 1250, "request_id": str(uuid4())}
    assert admin_client.post(root + "/points", json=deduction).status_code == 422
    assert admin_client.post(root + "/points", json={**deduction, "delta": -50}).json()["points"] == 1200

    def modify(path, **fields):
        return admin_client.post(root + path, json={"reason": "Account support", "request_id": str(uuid4()), **fields})

    assert modify("/status", active=False).json()["active"] is False
    assert client.get("/api/my-predictions").status_code == 401
    assert modify("/status", active=True).json()["active"] is True
    with database.SessionLocal.begin() as db:
        db.execute(update(User).where(User.id == user_id).values(
            locked_until=datetime.now(timezone.utc) + timedelta(minutes=15), failed_login_attempts=5,
        ))
    assert modify("/unlock").json()["locked"] is False
    assert client.post("/auth/login", json={"username": "player", "password": PASSWORD}).status_code == 200
    with database.SessionLocal() as db:
        events = db.scalars(select(AdminUserChange).where(AdminUserChange.user_id == user_id)).all()
        assert len(events) == 5
        event = db.get(AdminUserChange, change["request_id"])
        assert (event.before, event.after, event.reason) == ("1000", "1250", "Correct starting points")

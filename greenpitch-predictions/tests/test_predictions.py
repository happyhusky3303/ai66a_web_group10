from sqlalchemy import select

from app import database
from app.models import Prediction, User
from app.routers import predictions
from app.routers.auth import hash_password


def before_match(match_id="123"):
    return {
        "id": match_id,
        "status": "Before",
        "competition": "Example League",
        "home_team": "Home FC",
        "away_team": "Away FC",
        "home_crest": None,
        "away_crest": None,
        "utc_date": "2026-11-07T18:00:00Z",
        "provider_data": {},
    }


def set_matches(monkeypatch, fixture_matches):
    async def fetch_matches():
        return fixture_matches

    monkeypatch.setattr(predictions, "_fetch_matches", fetch_matches)


def register_user(client, username="green_pitch"):
    response = client.post(
        "/auth/register",
        json={"username": username, "password": "valid-password"},
    )
    assert response.status_code == 201
    return response.json()


def test_prediction_requires_authentication(client, monkeypatch):
    set_matches(monkeypatch, [before_match()])

    response = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "home", "stake": 100},
    )

    assert response.status_code == 401


def test_create_prediction_and_reject_duplicate(client, monkeypatch):
    register_user(client)
    set_matches(monkeypatch, [before_match()])
    payload = {"match_id": "123", "predicted_winner": "home", "stake": 250}

    response = client.post("/api/predict", json=payload)

    assert response.status_code == 201
    assert response.json() == {
        "id": 1,
        "match_id": "123",
        "predicted_winner": "home",
        "stake": 250,
        "is_resolved": False,
        "user_points": 750,
    }
    assert client.post("/api/predict", json=payload).status_code == 409

    with database.SessionLocal() as db:
        prediction = db.scalar(select(Prediction).where(Prediction.match_id == "123"))
        assert prediction is not None
        assert prediction.home_team == "Home FC"
        assert prediction.stake == 250
        assert db.get(User, prediction.user_id).points == 750

    choices = client.get("/api/my-predictions")
    assert choices.status_code == 200
    assert choices.json() == {
        "predictions": [{"match_id": "123", "predicted_winner": "home", "stake": 250}],
    }


def test_prediction_rejects_invalid_winner(client):
    register_user(client)

    response = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "tie", "stake": 100},
    )

    assert response.status_code == 422


def test_prediction_rejects_nonpositive_or_insufficient_stake(client, monkeypatch):
    user = register_user(client)
    set_matches(monkeypatch, [before_match()])

    invalid = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "home", "stake": 0},
    )
    insufficient = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "home", "stake": 1001},
    )

    assert invalid.status_code == 422
    assert insufficient.status_code == 409
    with database.SessionLocal() as db:
        assert db.get(User, user["id"]).points == 1000
        assert db.scalar(select(Prediction)) is None


def test_prediction_rejects_mismatched_user_id(client):
    register_user(client)

    response = client.post(
        "/api/predict",
        json={"user_id": 999, "match_id": "123", "predicted_winner": "home", "stake": 100},
    )

    assert response.status_code == 403


def test_prediction_rejects_missing_or_started_match(client, monkeypatch):
    register_user(client)
    set_matches(monkeypatch, [before_match("456")])

    missing = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "home", "stake": 100},
    )
    assert missing.status_code == 404

    set_matches(monkeypatch, [{**before_match(), "status": "Ongoing"}])
    started = client.post(
        "/api/predict",
        json={"match_id": "123", "predicted_winner": "home", "stake": 100},
    )
    assert started.status_code == 409


def test_admin_resolution_updates_points_once(client, monkeypatch):
    set_matches(
        monkeypatch,
        [{**before_match(), "status": "Ended", "winner": "home"}],
    )
    with database.SessionLocal() as db:
        winner = User(username="winner", password_hash=hash_password("valid-password"))
        loser = User(username="loser", password_hash=hash_password("valid-password"))
        db.add_all([winner, loser])
        db.flush()
        db.add_all(
            [
                Prediction(
                    user_id=winner.id,
                    match_id="123",
                    predicted_winner="home",
                ),
                Prediction(
                    user_id=loser.id,
                    match_id="123",
                    predicted_winner="away",
                ),
            ]
        )
        db.commit()
        winner_id, loser_id = winner.id, loser.id

    response = client.post(
        "/admin/resolve",
        headers={"X-Admin-Token": "test-admin-token"},
        json={"match_id": "123", "actual_winner": "home"},
    )

    assert response.status_code == 200
    assert response.json() == {"match_id": "123", "resolved_predictions": 2}

    repeated = client.post(
        "/admin/resolve",
        headers={"X-Admin-Token": "test-admin-token"},
        json={"match_id": "123", "actual_winner": "home"},
    )
    assert repeated.json()["resolved_predictions"] == 0

    with database.SessionLocal() as db:
        assert db.get(User, winner_id).points == 1100
        assert db.get(User, loser_id).points == 900
        assert all(
            prediction.is_resolved
            for prediction in db.scalars(select(Prediction)).all()
        )


def test_admin_resolution_credits_double_stake_for_wins_and_forfeits_losses(client, monkeypatch):
    set_matches(
        monkeypatch,
        [{**before_match(), "status": "Ended", "winner": "home"}],
    )
    with database.SessionLocal() as db:
        winner = User(username="stake_winner", password_hash="unused", points=750)
        loser = User(username="stake_loser", password_hash="unused", points=750)
        db.add_all([winner, loser])
        db.flush()
        db.add_all(
            [
                Prediction(user_id=winner.id, match_id="123", predicted_winner="home", stake=250),
                Prediction(user_id=loser.id, match_id="123", predicted_winner="away", stake=250),
            ]
        )
        db.commit()
        winner_id, loser_id = winner.id, loser.id

    response = client.post(
        "/admin/resolve",
        headers={"X-Admin-Token": "test-admin-token"},
        json={"match_id": "123", "actual_winner": "home"},
    )
    assert response.status_code == 200

    with database.SessionLocal() as db:
        assert db.get(User, winner_id).points == 1250
        assert db.get(User, loser_id).points == 750


def test_my_matches_auto_resolution_pays_out_once(client, monkeypatch):
    register_user(client)
    with database.SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "green_pitch"))
        user.points = 800
        db.add(Prediction(
            user_id=user.id,
            match_id="123",
            predicted_winner="home",
            stake=200,
        ))
        db.commit()

    set_matches(monkeypatch, [{**before_match(), "status": "Ended", "winner": "home"}])

    first = client.get("/api/my-matches")
    assert first.status_code == 200
    assert first.json()["user_points"] == 1200
    prediction = first.json()["predictions"][0]
    assert prediction["stake"] == 200
    assert prediction["payout"] == 400
    assert prediction["net_points"] == 200

    second = client.get("/api/my-matches")
    assert second.json()["user_points"] == 1200


def test_admin_resolution_rejects_invalid_token(client, monkeypatch):
    async def unexpected_fetch():
        raise AssertionError("match provider should not be called for an invalid token")

    monkeypatch.setattr(predictions, "_fetch_matches", unexpected_fetch)

    response = client.post(
        "/admin/resolve",
        headers={"X-Admin-Token": "wrong-token"},
        json={"match_id": "123", "actual_winner": "home"},
    )

    assert response.status_code == 403


def test_leaderboard_orders_users_and_limits_results(client):
    with database.SessionLocal() as db:
        db.add_all(
            [
                User(
                    username=f"user_{index:02}",
                    password_hash="unused",
                    points=1000 + index,
                )
                for index in range(52)
            ]
        )
        db.commit()

    response = client.get("/api/leaderboard")

    assert response.status_code == 200
    leaderboard = response.json()["leaderboard"]
    assert len(leaderboard) == 50
    assert leaderboard[0] == {
        "rank": 1,
        "username": "user_51",
        "points": 1051,
    }
    assert leaderboard[-1]["rank"] == 50

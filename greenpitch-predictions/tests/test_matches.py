import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app.routers import matches


def provider_match(status="SCHEDULED", winner=None):
    return {
        "id": 123,
        "status": status,
        "competition": {"name": "Example League"},
        "utcDate": "2026-11-07T18:00:00Z",
        "homeTeam": {"name": "Home FC", "crest": "home.png"},
        "awayTeam": {"name": "Away FC", "crest": "away.png"},
        "score": {
            "winner": winner,
            "fullTime": {"home": 2, "away": 1},
        },
    }


@pytest.mark.parametrize(
    ("provider_status", "expected_status"),
    [
        ("SCHEDULED", "Before"),
        ("IN_PLAY", "Ongoing"),
        ("FINISHED", "Ended"),
        ("UNKNOWN", "Unavailable"),
    ],
)
def test_normalize_match(provider_status, expected_status):
    normalized = matches._normalize_match(provider_match(provider_status, "HOME_TEAM"))

    assert normalized["id"] == "123"
    assert normalized["status"] == expected_status
    assert normalized["winner"] == "home"
    assert normalized["home_team"] == "Home FC"
    assert normalized["home_score"] == 2
    assert normalized["provider_data"]["status"] == provider_status


def test_fetch_matches_requires_provider_api_key(monkeypatch):
    monkeypatch.delenv("FOOTBALL_DATA_API_KEY", raising=False)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(matches._fetch_matches())

    assert exc_info.value.status_code == 503


def test_fetch_matches_normalizes_and_caches_provider_response(monkeypatch):
    calls = []

    class MockResponse:
        headers = httpx.Headers({"x-requests-available-minute": "10"})
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"matches": [provider_match()]}

    class MockClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, url, *, headers, params):
            calls.append((url, headers, params))
            return MockResponse()

    monkeypatch.setenv("FOOTBALL_DATA_API_KEY", "test-api-key")
    monkeypatch.setattr(matches.httpx, "AsyncClient", lambda **_: MockClient())

    first = asyncio.run(matches._fetch_matches())
    second = asyncio.run(matches._fetch_matches())

    assert first == second
    assert len(calls) == 1
    assert calls[0][1] == {"X-Auth-Token": "test-api-key"}
    assert first[0]["id"] == "123"
    assert first[0]["status"] == "Before"


def test_match_endpoints_return_fixture_or_not_found(client, monkeypatch):
    async def fetch_matches():
        return [matches._normalize_match(provider_match())]

    monkeypatch.setattr(matches, "_fetch_matches", fetch_matches)

    listing = client.get("/api/matches")
    detail = client.get("/api/matches/123")
    missing = client.get("/api/matches/456")

    assert listing.status_code == 200
    assert listing.json()["matches"][0]["id"] == "123"
    assert detail.status_code == 200
    assert detail.json()["home_team"] == "Home FC"
    assert missing.status_code == 404


@pytest.mark.parametrize(
    "status_code",
    [429, 500],
)
def test_provider_http_errors_are_reported(client, monkeypatch, status_code):
    class MockResponse:
        def __init__(self):
            self.status_code = status_code

        def raise_for_status(self):
            request = httpx.Request("GET", "https://provider.test/matches")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("provider error", request=request, response=response)

    class MockClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, *_args, **_kwargs):
            return MockResponse()

    monkeypatch.setenv("FOOTBALL_DATA_API_KEY", "test-api-key")
    monkeypatch.setattr(matches.httpx, "AsyncClient", lambda **_: MockClient())

    response = client.get("/api/matches")

    assert response.status_code == 502
    assert response.json()["detail"] == f"Football data provider returned HTTP {status_code}."


def test_provider_invalid_payload_is_reported(client, monkeypatch):
    class MockResponse:
        headers = httpx.Headers()
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"matches": "not-a-list"}

    class MockClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, *_args, **_kwargs):
            return MockResponse()

    monkeypatch.setenv("FOOTBALL_DATA_API_KEY", "test-api-key")
    monkeypatch.setattr(matches.httpx, "AsyncClient", lambda **_: MockClient())

    response = client.get("/api/matches")

    assert response.status_code == 502
    assert "invalid match list" in response.json()["detail"]

# GreenPitch Predictions

A lightweight football match prediction web app built with FastAPI, SQLite,
SQLAlchemy, and vanilla HTML/CSS/JavaScript. It uses points only; there are no
real-money or betting features.

## Requirements

- Python 3.10+
- A football-data.org API token for live match listings

## Run locally

From this directory, create and activate a virtual environment, then install
dependencies:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Set the environment variables and start the development server:

```powershell
$env:FOOTBALL_DATA_API_KEY = "your-football-data.org-token"
$env:SESSION_SECRET_KEY = "a-long-random-secret"
$env:ADMIN_TOKEN = "a-separate-long-random-token"
uvicorn app.main:app --reload
```

Open <http://127.0.0.1:8000>. Interactive API documentation is available at
<http://127.0.0.1:8000/docs>. The SQLite database is created as
`predictions.db` in the current working directory.

`SESSION_SECRET_KEY` should be a unique, long random value in deployments. If
omitted for local development, the app generates a temporary key at startup, so
sessions will be invalidated when the process restarts. `ADMIN_TOKEN` is
required to resolve matches through the internal endpoint.

## API

- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /api/matches` — football-data.org fixtures, cached for 300 seconds
- `POST /api/predict` — authenticated user's `match_id` and `predicted_winner`
  (`home`, `away`, or `draw`); `user_id` is optional and must match the session
- `GET /api/leaderboard`
- `POST /admin/resolve` — requires `X-Admin-Token`; JSON body:
  `{"match_id":"...","actual_winner":"home"}` (winner may also be `away` or
  `draw`)

Match API responses include a `matches` array and cache metadata. The provider
token is sent only from the backend using football-data.org's `X-Auth-Token`
header. Configure `FOOTBALL_DATA_API_KEY` before requesting matches.

## Rate limits

SlowAPI limits each client IP to 5 requests/minute for registration and login,
10/minute for predictions, and 20/minute each for matches and leaderboard.
The external football provider is additionally protected by a shared in-memory
300-second response cache.
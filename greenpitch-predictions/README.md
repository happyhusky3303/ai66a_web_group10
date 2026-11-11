# GreenPitch Predictions

A lightweight football match prediction web app built with FastAPI, SQLite or
PostgreSQL, SQLAlchemy, and vanilla HTML/CSS/JavaScript. Users stake in-app
points on predictions; no real money or deposits are involved.

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

## Run tests

Install the development dependencies and run the test suite:

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest
```

Tests use a temporary SQLite database and mock football-data.org responses, so
they do not require a provider API token, PostgreSQL, or network access.
To run the admin tests on PostgreSQL, set `GREENPITCH_TEST_POSTGRES_URL` to a
`postgresql+psycopg://` URL for a disposable test database and run
`python -m pytest tests/test_admin.py`. Each test uses a temporary schema.

Set the environment variables and start the development server:

```powershell
$env:FOOTBALL_DATA_API_KEY = "your-football-data.org-token"
$env:SESSION_SECRET_KEY = "a-long-random-secret"
$env:ADMIN_TOKEN = "a-separate-long-random-token"
# Optional: set this to use PostgreSQL instead of the default SQLite database.
# $env:DATABASE_URL = "postgresql://postgres:YOUR-PASSWORD@db.tyqgbczmvhxrlsjhjzbu.supabase.co:5432/postgres"
uvicorn app.main:app --reload
```

Open <http://127.0.0.1:8000>. Interactive API documentation is available at
<http://127.0.0.1:8000/docs>. Without `DATABASE_URL`, the SQLite database is
created as `predictions.db` in the current working directory. To connect to
PostgreSQL, set `DATABASE_URL` to your PostgreSQL connection string before
starting the app. URL-encode reserved characters in the password (for example,
`@` as `%40`); for direct local runs, set it in the PowerShell environment as
shown above. Docker Compose reads `.env` automatically. Keep the real connection
string out of source control.

`SESSION_SECRET_KEY` should be a unique, long random value in deployments. If
omitted for local development, the app generates a temporary key at startup, so
sessions will be invalidated when the process restarts. `ADMIN_TOKEN` is
required to resolve matches through the internal endpoint.

## Run with Docker

Install Docker Desktop, then from this directory create a local environment
file and replace the example secrets with unique random values:

```powershell
Copy-Item .env.example .env
```

Set `FOOTBALL_DATA_API_KEY` in `.env` to enable live match listings. Docker
defaults to SQLite stored in the persistent `predictions_data` volume; to use
PostgreSQL instead, set `DATABASE_URL` in `.env` to your PostgreSQL connection
string (for example, the Supabase URL shown in `.env.example`, with your
password substituted). Then build and start the app:

```powershell
docker compose up --build -d
```

Open <http://localhost:8000>; the API documentation is at
<http://localhost:8000/docs>. With the default SQLite configuration, Docker
Compose stores the database in the persistent `predictions_data` volume. Stop
the app with `docker compose down`; the database volume is retained. To remove
the database as well, run `docker compose down --volumes`.

If the browser says it cannot connect, run Compose from this project directory
and recreate the container so the host port mapping is applied:

```powershell
docker compose up --build --force-recreate -d
docker compose ps
```

In the `PORTS` column, confirm that `8000` is mapped to host port `8000`
(shown as `0.0.0.0:8000->8000/tcp`).

For production behind HTTPS, set `SESSION_HTTPS_ONLY=true` in `.env`.

## Admin setup

On Render, set `BOOTSTRAP_ADMIN_USERNAME=happyhusky` in the service environment
and deploy the updated image. Confirm the username belongs to your existing
account before setting the variable. Startup grants the role after the schema
update using the server database. If the account is missing or inactive, startup
logs a warning and continues. Once the admin links appear, remove the variable.
The granted role persists and future restarts will respect a manual revocation.
For local Docker Compose, the same setting can be added to `.env`.

Back up the app database before upgrading. Start GreenPitch once against that
database to apply the startup schema updates. Register the account through the
regular sign-up flow, then run the following from the app environment using the
same database configuration as the server:

```powershell
python -m app.admin_cli grant exact_username
python -m app.admin_cli revoke exact_username
```

For Docker Compose, run the command inside the app container. After granting
access, sign in or refresh the page to see **Create Match** and **User Management**.
Revocation takes effect on the next admin request. Use HTTPS with
`SESSION_HTTPS_ONLY=true` in deployed environments.

- **Create Match** publishes a simulated fixture. Users can stake shared points
  until kick-off. Refresh the fixture list after kick-off, enter both scores,
  and confirm the final score to settle predictions. The score is permanent
  and the same result can be safely retried. Simulated payouts affect the
  shared leaderboard. Admin accounts cannot predict simulated matches.
- **User Management** searches regular accounts by username or email. Admins
  can deactivate or reactivate accounts, clear sign-in lockouts, and apply a
  signed points adjustment. Each change requires a reason and is recorded in
  the database with the actor, target, timestamp, and before/after values.
- The browser API is under `/api/admin`. Its writes require a signed-in admin
  and an `X-CSRF-Token` from an admin page. The separate token-protected
  `POST /admin/resolve` continues to handle provider match settlement.

## API

- `/` — personal analytics dashboard (sign-in required for account metrics)
- `/match-center` — fixtures and results list
- `/match/{match_id}` — match details and prediction choices
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /api/matches` — football-data.org fixtures, cached for 300 seconds
- `GET /api/matches/{match_id}` — normalized fixture plus the complete provider response
- `GET /api/my-predictions` — signed-in user's existing match picks, including
  their stake (`null` for legacy predictions)
- `POST /api/predict` — authenticated user's `match_id`, `predicted_winner`
  (`home`, `away`, or `draw`), and positive integer `stake`; `user_id` is
  optional and must match the session. The stake is deducted on placement.
- `GET /api/leaderboard`
- `POST /admin/resolve` — requires `X-Admin-Token`; JSON body:
  `{"match_id":"...","actual_winner":"home"}` (winner may also be `away` or
  `draw`)

Match API responses include a `matches` array and cache metadata. The provider
token is sent only from the backend using football-data.org's `X-Auth-Token`
header. Configure `FOOTBALL_DATA_API_KEY` before requesting matches.

Each user starts with 1,000 available points. A winning new prediction credits
2× its stake (a net gain of one stake after the initial deduction); a losing
prediction receives no refund. Existing predictions created before this change
have no recorded stake and retain the prior +100/−100 settlement rule. The
database migration leaves existing balances and predictions unchanged.

Users can claim a 500-point gift once per UTC date through the Daily Gift panel.
The balance increases when the authenticated claim succeeds.

## Rate limits

SlowAPI limits each client IP to 5 requests/minute for registration and login,
10/minute for predictions, and 20/minute each for matches and leaderboard.
The external football provider is additionally protected by a shared in-memory
300-second response cache. On Match Center, signed-in users see the available
prediction requests and reset countdown; this request allowance is shared by
visitors using the same IP address.
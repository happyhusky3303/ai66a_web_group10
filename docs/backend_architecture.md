# Backend Specifications

## 1. Tech Stack & Framework
*   **Framework:** FastAPI.
*   **Server:** Uvicorn.
*   **HTTP Client:** `httpx` (for calling the external football data API).

## 2. API Endpoints
*   `POST /auth/register`: Create a new user account.
*   `POST /auth/login`: Authenticate user and issue session/token.
*   `GET /api/matches`: Return a list of matches. Must utilize caching to avoid hitting 3rd-party API rate limits.
*   `POST /api/predict`: Accept user ID, match ID, and prediction choice. Validate that the match status is "Before" (has not started).
*   `GET /api/leaderboard`: Fetch top users ordered by points descending.
*   `POST /admin/resolve`: (Internal/Admin) Trigger point distribution for a concluded match.

## 3. Caching Strategy
*   The external Football API has strict rate limits.
*   Implement an in-memory cache (or simple caching mechanism) in the backend. 
*   When `GET /api/matches` is called, return cached data if it is less than 5 minutes old. Only fetch from the external API if the cache has expired.

## 4. Coding Agent Instructions
*   Structure the backend using `APIRouter` to split `auth`, `matches`, and `predictions` logic.
*   Implement standard FastAPI dependency injection for database sessions.
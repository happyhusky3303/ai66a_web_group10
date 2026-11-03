# Rate Limiting & API Protection

## 1. Tech Stack
*   **Library:** `slowapi` (a rate-limiting extension for FastAPI based on limits).

## 2. Limits Configuration
We must protect our own endpoints from spam/abuse, while also managing how often we query the external sports API.

### Inbound Limits (Protecting our FastAPI App)
*   `POST /auth/register` and `/auth/login`: **5 requests per minute** per IP. (Prevents brute-forcing).
*   `POST /api/predict`: **10 requests per minute** per IP. (Prevents spamming the database).
*   `GET /api/matches`: **20 requests per minute** per IP.
*   `GET /api/leaderboard`: **20 requests per minute** per IP.

### Outbound Limits (Protecting the 3rd-Party API)
*   The external football API has hard rate limits. Our FastAPI backend must NEVER exceed this limit, regardless of how many users hit our `GET /api/matches` endpoint.
*   **Mechanism:** Cache the external API response for a predefined Time-To-Live (TTL), e.g., 300 seconds (5 minutes). 

## 3. Coding Agent Instructions
*   Initialize `Limiter(key_func=get_remote_address)` in the main FastAPI app.
*   Apply `@limiter.limit("X/minute")` decorators to the respective router endpoints.
*   Add a custom exception handler for `RateLimitExceeded` to return clean JSON errors to the frontend.
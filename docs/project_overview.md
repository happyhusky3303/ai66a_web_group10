# GreenPitch Football Predictions: Project Overview

## 1. Main Idea
GreenPitch is a web-based football score prediction platform. Users can view upcoming football matches (fetched from a 3rd-party API), stake in-app points on match outcomes, and track their available balance and success on a global leaderboard.

## 2. Tech Stack
*   **Backend:** Python with FastAPI.
*   **Database:** SQLite using SQLAlchemy ORM.
*   **Frontend:** Vanilla HTML, CSS, and JavaScript (served via FastAPI templates or static files).
*   **Rate Limiting & Caching:** `slowapi` for endpoint protection, in-memory caching for 3rd-party API responses.

## 3. Core Features
1.  **Authentication:** User registration and login system.
2.  **Match Listing:** Displaying matches categorized by status: Before (upcoming), Ongoing (live), Ended (completed with results).
3.  **Prediction Engine:** Users stake a positive number of available points on a match winner (Home, Away, or Draw).
    *   The stake is deducted when the prediction is placed.
    *   A win pays 2× the stake, for a net gain of one stake; a loss is not refunded.
    *   Predictions are locked once a match transitions to "Ongoing".
4.  **Leaderboard:** A global ranking of all users based on their total points.

## 4. Coding Agent Instructions
*   Keep the architecture modular. Follow the separation of concerns between routers, models, and static assets.
*   Ensure strict adherence to the design rules (documented in `FRONTEND.md`) and rate-limiting constraints (documented in `RATE_LIMITING.md`).
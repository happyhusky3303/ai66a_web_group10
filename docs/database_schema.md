# Database Specifications

## 1. Tech Stack
*   **Database:** SQLite (`predictions.db`).
*   **ORM:** SQLAlchemy.

## 2. Models

### User Model (`users` table)
*   `id`: Integer, Primary Key, Auto-increment.
*   `username`: String, Unique, Indexed.
*   `password_hash`: String (hashed password).
*   `points`: Integer, Default = 1000.

### Prediction Model (`predictions` table)
*   `id`: Integer, Primary Key, Auto-increment.
*   `user_id`: Integer, Foreign Key (`users.id`).
*   `match_id`: String, Indexed (ID from the external sports API).
*   `predicted_winner`: String (`home`, `away`, or `draw`).
*   `stake`: Nullable Integer. New predictions store the positive points staked. `NULL` identifies legacy predictions made before stake-based scoring.
*   `is_resolved`: Boolean, Default = False (indicates if the prediction has been settled).
*   `won`: Boolean, Default = False (indicates if the prediction was correct; only valid if `is_resolved` is True).

## 3. Points and Settlement
*   The user's `points` balance is available points. Submitting a prediction atomically deducts its stake.
*   A winning new prediction credits twice its stake at settlement; after its original deduction, the net balance change is one stake gained.
*   A losing new prediction receives no payout or refund; the original stake remains forfeited.
*   Legacy predictions with a `NULL` stake keep the old settlement rule (+100 points for a win, −100 for a loss). Their balances are not changed during migration.

## 4. Coding Agent Instructions
*   Include a `database.py` file to handle engine creation and `get_db()` dependency.
*   Use SQLAlchemy `declarative_base`.
*   Ensure thread safety for SQLite by using `connect_args={"check_same_thread": False}` in the engine definition.
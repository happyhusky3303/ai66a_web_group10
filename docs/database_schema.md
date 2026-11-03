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
*   `is_resolved`: Boolean, Default = False (indicates if the match has ended and points were distributed).
*   `won`: Boolean, Default = False (indicates if the prediction was correct; only valid if `is_resolved` is True).

## 3. Coding Agent Instructions
*   Include a `database.py` file to handle engine creation and `get_db()` dependency.
*   Use SQLAlchemy `declarative_base`.
*   Ensure thread safety for SQLite by using `connect_args={"check_same_thread": False}` in the engine definition.
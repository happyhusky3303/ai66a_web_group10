import argparse

from sqlalchemy import select

from app.database import SessionLocal
from app.models import User


def main() -> None:
    parser = argparse.ArgumentParser(description="Grant or revoke GreenPitch admin access.")
    parser.add_argument("action", choices=("grant", "revoke"))
    parser.add_argument("username", help="Exact username of an existing account")
    args = parser.parse_args()
    with SessionLocal.begin() as db:
        user = db.scalar(select(User).where(User.username == args.username))
        if user is None or (args.action == "grant" and not user.is_active):
            parser.error("Choose an existing account that is active when granting access.")
        user.is_admin = args.action == "grant"
        print(f"Admin access {'granted' if user.is_admin else 'revoked'} for {user.username} (ID {user.id}).")


if __name__ == "__main__":
    main()

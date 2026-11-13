"""Import provider fixtures and reconcile historical predictions."""
import argparse
from datetime import date, datetime, timezone
import logging
import os

import httpx
from sqlalchemy import select

from app.database import Base, SessionLocal, engine
from app.models import Prediction, ProviderFixture
from app.routers.matches import FOOTBALL_DATA_URL, _normalize_match, fixture_window, store_fixtures
from app.routers.predictions import _settle_prediction
from app.observability import configure_logging, log_event


logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--date", type=date.fromisoformat)
    source.add_argument("--match-id")
    source.add_argument("--window", action="store_true", help="Sync the current UTC browsing window")
    source.add_argument("--overdue", action="store_true")
    parser.add_argument("--apply", action="store_true", help="Persist fixtures and settle confirmed results")
    args = parser.parse_args()
    key = os.getenv("FOOTBALL_DATA_API_KEY")
    if not key:
        parser.error("Set FOOTBALL_DATA_API_KEY before running this command.")
    if args.match_id and not (args.match_id.isascii() and args.match_id.isdigit()):
        parser.error("Use a numeric provider match ID.")

    if args.apply:
        Base.metadata.create_all(bind=engine)

    url = FOOTBALL_DATA_URL.rstrip("/")
    with SessionLocal() as db, httpx.Client(
        headers={"X-Auth-Token": key}, timeout=10,
    ) as client:
        if args.overdue:
            cutoff = datetime.now(timezone.utc).isoformat()
            ids = db.scalars(select(Prediction.match_id).where(
                Prediction.is_resolved.is_(False),
                ~Prediction.match_id.startswith("sim-"),
                (Prediction.utc_date.is_(None) | (Prediction.utc_date <= cutoff)),
            ).distinct().order_by(Prediction.match_id)).all()
            db.rollback()
            ids = [match_id for match_id in ids if match_id.isascii() and match_id.isdigit()]
            requests = [(url, {"ids": ",".join(ids[i:i + 20])}) for i in range(0, len(ids), 20)]
        elif args.match_id:
            requests = [(f"{url}/{args.match_id}", {})]
        elif args.window:
            requests = [(url, fixture_window())]
        else:
            requests = [(url, {"date": args.date.isoformat()})]

        if not requests:
            log_event(logger, logging.INFO, "fixture_reconcile.no_overdue_fixtures")
        for endpoint, params in requests:
            log_event(logger, logging.INFO, "fixture_reconcile.request.started",
                      filter_keys=sorted(params), batch_size=len(params.get("ids", "").split(",")) if "ids" in params else None)
            try:
                response = client.get(endpoint, params=params)
            except httpx.RequestError as exc:
                log_event(logger, logging.ERROR, "fixture_reconcile.provider_failed",
                          reason="network_error", exception_type=type(exc).__name__)
                raise SystemExit("Could not reach the provider. Retry on the next scheduled run.") from None
            if response.is_error:
                log_event(logger, logging.ERROR, "fixture_reconcile.provider_failed", status_code=response.status_code)
                raise SystemExit(f"Provider returned HTTP {response.status_code}.")
            try:
                payload = response.json()
                records = [payload] if args.match_id else payload["matches"]
                if not isinstance(records, list) or any(
                    not isinstance(raw, dict) or type(raw.get("id")) is not int or raw["id"] <= 0
                    for raw in records
                ):
                    raise ValueError
                fixtures = [_normalize_match(raw) for raw in records]
            except (KeyError, ValueError, TypeError, AttributeError):
                log_event(logger, logging.ERROR, "fixture_reconcile.invalid_provider_payload")
                raise SystemExit("Provider returned an invalid fixture response.") from None
            if args.overdue:
                requested = set(params["ids"].split(","))
                returned = {fixture["id"] for fixture in fixtures}
                if returned - requested:
                    log_event(logger, logging.ERROR, "fixture_reconcile.unrequested_fixture_ids",
                              extra_count=len(returned - requested))
                    raise SystemExit("Provider returned fixture IDs outside the requested batch.")
                if requested - returned:
                    log_event(logger, logging.WARNING, "fixture_reconcile.provider_omitted_fixtures",
                              omitted_count=len(requested - returned))
            if args.match_id and fixtures[0]["id"] != args.match_id:
                log_event(logger, logging.ERROR, "fixture_reconcile.fixture_id_mismatch")
                raise SystemExit("Provider response did not match the requested fixture ID.")
            if args.apply:
                store_fixtures(db, fixtures)
            for fixture in sorted(fixtures, key=lambda item: item["id"]):
                if args.apply:
                    fixture = db.get(ProviderFixture, fixture["id"]).payload
                if args.date or args.window or fixture["status"] != "Ended" or not fixture["winner"]:
                    log_event(logger, logging.INFO, "fixture_reconcile.fixture_processed",
                              fixture_id=fixture["id"], status=fixture["status"], settled_count=0,
                              applied=args.apply)
                    continue
                predictions = db.scalars(select(Prediction).where(
                    Prediction.match_id == fixture["id"], Prediction.is_resolved.is_(False),
                ).order_by(Prediction.user_id)).all()
                settled_count = 0
                for prediction in predictions:
                    if not args.apply or _settle_prediction(db, prediction, fixture["winner"]):
                        settled_count += 1
                log_event(logger, logging.INFO, "fixture_reconcile.fixture_processed",
                          fixture_id=fixture["id"], status=fixture["status"],
                          candidate_count=len(predictions), settled_count=settled_count, applied=args.apply)
            if args.apply:
                db.commit()
            log_event(logger, logging.INFO, "fixture_reconcile.request.completed",
                      fixture_count=len(fixtures), applied=args.apply)


if __name__ == "__main__":
    configure_logging()
    main()

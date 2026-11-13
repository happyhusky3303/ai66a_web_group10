"""Run provider fixture synchronization outside web server processes."""

import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from app.observability import configure_logging, log_event


logger = logging.getLogger(__name__)


async def run_fixture_job(mode: str) -> None:
    while True:
        started = time.perf_counter()
        status = None
        log_event(logger, logging.INFO, "fixture_job.started", mode=mode)
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "app.reconcile_fixtures", mode, "--apply",
            )
            try:
                status = await process.wait()
            except asyncio.CancelledError:
                if process.returncode is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                    await process.wait()
                raise
            log_event(
                logger,
                logging.INFO if status == 0 else logging.ERROR,
                "fixture_job.completed",
                mode=mode,
                exit_code=status,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
            )
        except OSError:
            logger.exception("Could not start fixture job", extra={"event_fields": {"event": "fixture_job.start_failed", "mode": mode}})

        delay = 900
        if mode == "--window":
            now = datetime.now(timezone.utc)
            next_run = now.replace(hour=0, minute=5, second=0, microsecond=0)
            if next_run <= now:
                next_run += timedelta(days=1)
            delay = (next_run - now).total_seconds()
            if status != 0:
                delay = min(delay, 900)
        await asyncio.sleep(delay)


async def main() -> None:
    if not os.getenv("FOOTBALL_DATA_API_KEY"):
        log_event(logger, logging.ERROR, "fixture_scheduler.missing_provider_key")
        raise SystemExit(2)
    log_event(logger, logging.INFO, "fixture_scheduler.started")
    jobs = [
        asyncio.create_task(run_fixture_job(mode))
        for mode in ("--window", "--overdue")
    ]
    try:
        await asyncio.gather(*jobs)
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


if __name__ == "__main__":
    configure_logging()
    asyncio.run(main())

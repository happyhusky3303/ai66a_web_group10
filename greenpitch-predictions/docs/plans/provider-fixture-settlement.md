# Provider fixture persistence and settlement

The fixture list requests yesterday through seven days ahead. My Matches and the token-based resolve route both depend on that list for official results. Once an unresolved fixture leaves the window, the saved prediction remains visible but has no result to settle against. Store one current snapshot per provider fixture in PostgreSQL and refresh unresolved fixtures independently of the browsing window.

## 1. Recover overdue predictions

- In the provider integration, add an authenticated match-by-ID lookup. Verify Leeds vs Tottenham (provider ID 560632 from the prior dashboard) against its stored kickoff and teams. Check the returned status and official winner before making any balance change.
- Give the reconciliation command a dry-run mode that lists affected predictions and projected balance changes. On apply, reuse the existing settlement function, preserving its legacy null-stake rules and recording the points event in the same transaction.
- Document how to preview and apply the recovery. Validate against fixtures that return a final result, a postponement, and a provider error. Exit when verified final results settle once and unresolved cases retain their stakes and have a recorded reason.

## 2. Persist fixtures and use them for history

- Add a provider fixture table keyed by provider and fixture ID. Store kickoff, teams, competition, status, score, winner, provider update time, and last successful sync. Add only the optional payload fields the match page needs.
- Upsert from the existing fixture sync and historical lookups. Keep the last successful snapshot across missing list entries and request failures. Prevent stale updates from overwriting newer results.
- Backfill IDs referenced by existing predictions. Move My Matches and historical match detail reads to stored fixtures. Keep Match Center date filters and the existing simulated fixture path. Keep prediction eligibility tied to kickoff and fresh fixture status.
- Validate with a fixture that disappears from the next list response. Exit when the historical page still opens and shows its saved score and result.

## 3. Reconcile automatically

- Schedule a server-side job to select distinct overdue, unresolved provider fixtures and refresh them by ID or in supported batches. Apply the existing conditional settlement in the same transaction as the confirmed result and payout. Keep page visits independent of settlement.
- Respect provider limits with bounded batches and backoff. Retain postponed fixtures for later checks and flag long-outstanding, cancelled, or inaccessible fixtures for review. Define a separate refund policy before automating refunds.
- Document deployment, job schedule, retry behavior, and the overdue queue. Validate overlapping runs and a simulated provider outage. Exit when a fixture can age out, settle without a dashboard visit, and pay exactly once after a retry.

## Running reconciliation

From the application directory, configure the same DATABASE_URL and FOOTBALL_DATA_API_KEY used by the web service.

- Preview a fixture with `python -m app.reconcile_fixtures --match-id 560632`.
- Apply that fixture with `python -m app.reconcile_fixtures --match-id 560632 --apply`.
- Import a UTC date with `python -m app.reconcile_fixtures --date 2026-10-13 --apply`. Date imports only store fixture snapshots.
- Configure the hosting scheduler to run `python -m app.reconcile_fixtures --overdue --apply` every 15 minutes. The command exits on a provider rate limit so the next scheduled run can retry. Check job output for provider errors and pending fixtures that need review.

## Implementation milestones for the two scheduled jobs

### 1. Daily fixture sync

- Extend app/reconcile_fixtures.py with a mutually exclusive --window option. Share a UTC date-window helper with app/routers/matches.py so both paths request yesterday through seven days ahead. Confirm the provider's upper-bound behavior with a boundary fixture.
- Reuse normalization and store_fixtures. Validate the complete response before writing. Preview by default and commit only with --apply. Preserve saved snapshots on empty responses or provider errors.
- Schedule python -m app.reconcile_fixtures --window --apply at 00:05 UTC daily. Log the requested window, returned fixture count, and success or failure without logging secrets.
- Validate with a mocked response containing past and future fixtures. Repeat the import and check that row count stays stable. Simulate a 429 and verify the saved data remains available. Exit when the first staging run reports success and its fixtures are visible in the database.

### 2. Overdue result reconciliation

- Harden the existing --overdue command. Select distinct unresolved provider fixture IDs whose kickoff has passed. Include older predictions with missing kickoff dates. Refresh in bounded ID batches and report omitted IDs and non-final results for follow-up.
- Settle only confirmed final results. Use the saved fixture and existing conditional settlement function so fixture state, prediction outcome, balance, and points event commit together. Retry rate limits and transient failures on the next run. Keep postponed and cancelled fixtures visible for review.
- Schedule python -m app.reconcile_fixtures --overdue --apply every 15 minutes in UTC. Use the same DATABASE_URL and FOOTBALL_DATA_API_KEY as the web service. In staging, verify that settlement works with the web process stopped.
- Test an aged-out fixture, a missing result, and overlapping runs. Exit when an aged-out winning pick is paid exactly once and an unresolved pick remains pending through a provider failure.

### 3. Match Center and rollout

- Serve Match Center from saved fixtures within its browsing window. Let Refresh reload the database view. If adding refresh-triggered sync, apply a shared freshness check and lock across web processes so concurrent clicks share one provider request.
- Enable the fixture sync first and confirm the database is populated. Then enable reconciliation and verify scheduler logs and the overdue queue. Document schedule, credentials, manual reruns, and how to pause each job.
- Validate that Refresh still returns saved fixtures during a provider outage and that simultaneous refreshes do not create duplicate provider calls. Exit when both scheduled jobs have completed successfully in staging and an operator can identify a failed run and safely retry it.

## Deployment settings

Run both commands from the application directory with the web service's DATABASE_URL and FOOTBALL_DATA_API_KEY. Use UTC for both schedules.

| Job | Cron | Command |
| --- | --- | --- |
| Fixture sync | 5 0 * * * | python -m app.reconcile_fixtures --window --apply |
| Settlement | */15 * * * * | python -m app.reconcile_fixtures --overdue --apply |

Run the fixture sync once and check its logs before setting MATCH_CENTER_FROM_DATABASE=1 on the web service. In that mode, Match Center and its Refresh button read saved fixtures. Clear the flag to restore live list reads during rollback. For a failed sync, rerun its command after the provider recovers.

## Jobs started by the web service

The web service starts both fixture jobs after database initialization whenever FOOTBALL_DATA_API_KEY is configured. Both jobs run on startup. Fixture sync then runs daily at 00:05 UTC and retries failed runs within 15 minutes. Overdue settlement repeats 15 minutes after each run completes.

For Docker Compose, run docker compose up --build. For Render, deploy the updated web service with its existing provider and database variables. The jobs run inside the web service, so an idle or stopped instance resumes the jobs on its next startup. Check service logs for fixture counts and errors. Set FIXTURE_JOBS_ENABLED=0 on extra instances or when using the standalone cron jobs.

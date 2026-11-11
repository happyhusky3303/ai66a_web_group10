# GreenPitch admin accounts and simulated matches

## Goal

Give authorized GreenPitch admins two pages. **Create Match** publishes simulated fixtures and records final scores. **User Management** finds accounts, manages access, and adjusts available points.

## Current state

- GreenPitch uses FastAPI, SQLAlchemy, Jinja templates, and vanilla JavaScript. SQLite and PostgreSQL are supported. Startup creates missing tables and upgrades selected columns on existing tables.
- The session stores a user ID. The users table tracks account activation and login lockouts but has no admin role. The authenticated API dependency already checks activation against the database.
- Match Center and match details read from the provider cache. Prediction creation and My Matches also look up provider fixtures directly. There is no database table for locally created fixtures.
- The existing token-protected POST /admin/resolve accepts a winner only for a concluded provider fixture whose official result agrees. The prediction settlement code already guards each prediction against duplicate payouts and updates balances using SQL arithmetic.

## Desired end state and scope

- An administrator signs in through the regular login and sees **Create Match** and **User Management** in the navbar. Both HTML pages and all admin APIs require the role on the server.
- An admin publishes a fixture with home team, away team, competition and kick-off time. The fixture appears in Match Center and match details with a visible **Simulated** label. It is available for predictions until kick-off.
- An admin enters both final scores after kick-off. The server derives home win, away win, or draw, and settles all picks in the same transaction. The score and result appear in Match Center, match details, and My Matches.
- User Management provides paginated search by username or email, available points, account status, and actions to deactivate, reactivate, unlock, and add or remove points. Mutations record the acting admin, target, reason, and outcome.

## Assumptions and non-goals

- Simulated matches are visible to all users. Stakes and payouts use the shared in-app points balance, as confirmed. The existing leaderboard ranks that balance, so simulated stakes and payouts also affect standings. Admin accounts cannot predict simulated matches.
- Publish directly as an upcoming fixture. Display kick-off in the browser's local time and store it in UTC. After kick-off the fixture awaits a final score and stays closed to predictions. One final score is permanent for this release.
- User Management operates on regular accounts. Account deletion, impersonation, password changes, role changes through the UI, cancellation or reversal of settled matches, and edits to provider fixtures are outside the initial scope.
- Provision the first admin by promoting an existing account with an operator-only command. Test migrations on both supported databases. Use the existing dark UI and status conventions.

## Affected components

- Models, startup schema updates, authentication dependencies, and page router in app/models.py, app/main.py, and app/routers/auth.py.
- New admin API router and CLI command, plus app/routers/matches.py and app/routers/predictions.py.
- Two Jinja templates, authenticated navigation, static/js/app.js, and static/css/style.css.
- Focused admin API, page, match, and prediction tests. Update README.md for setup and operation.

## Milestone 1 — Admin identity and authorization

1. Review this plan with the team and record the role provisioning decision. Add an is_admin boolean with a database default of false for existing rows and new accounts. Keep it outside public signup inputs.
2. Add an operator-only CLI to promote an existing active account identified by exact username. Require an explicit account argument, display the account ID and username, and make reruns idempotent. Document command usage and how an operator revokes the role.
3. Add a reusable admin dependency that reads current activation and role on each request. Return 401 for unauthenticated APIs and 403 for signed-in non-admins. Admin pages redirect anonymous users to login and return 403 to regular users. Add a role flag to the authenticated session response for navbar visibility.
4. Apply the role dependency to all new admin routes. Keep the existing token-protected official settlement contract available. For new session-cookie mutations validate a CSRF token in a request header and keep production cookies secure.

**Validation.** Upgrade an existing database and initialize an empty one. Exercise anonymous, regular, admin, inactive and revoked sessions against the new authorization dependency. Confirm a crafted signup cannot set the role and a cross-site mutation is rejected.

**Exit.** An operator can provision an admin without changing the signup flow, and the server enforces the role independently of the navbar.

## Milestone 2 — Create Match and fixture integration

1. Add a simulated fixture table with a stable prefixed public ID such as sim-123, team names, competition, UTC kick-off, nullable scores, finalization metadata, and creator ID. Reuse the normalized fixture shape and add source=simulated.
2. Add GET /admin/create-match and admin APIs to list simulated fixtures and publish one. Validate trimmed team names, distinct teams, field lengths, and a future kick-off. On the page show a publish form and list of fixtures with kick-off and status. Prevent accidental repeat submissions while the request is pending.
3. Merge the simulated fixtures into Match Center with a stable sort. Resolve simulated IDs directly from the database for match details and prediction placement. Look up simulated picks separately in My Matches. Keep the provider cache dedicated to provider fixtures. If the provider is unavailable, serve simulations with a visible live-data warning and keep simulated details and predictions usable.
4. Add the Simulated label to list and detail views. Use the existing upcoming and ended groups and show a distinct awaiting-result state after kick-off. Enforce kick-off and the admin prediction restriction on the server.

**Validation.** Publish a fixture with the admin account and open it as a regular user. Check persistence across restart, a provider outage, invalid form values, provider ID compatibility, and the prediction cutoff.

**Exit.** A simulated fixture can be published, found, and predicted by regular users using the existing points flow.

## Milestone 3 — Final score and settlement

1. Add POST /api/admin/simulated-matches/{id}/finalize with integer home_score and away_score. On **Create Match**, show the score form for eligible fixtures, the score and derived outcome in the confirmation, and the final score plus settlement count after success. Reject early finalization and provider IDs.
2. Use a conditional database update to finalize only an eligible fixture without a score. In that transaction, derive the winner and settle unresolved predictions through the existing payout logic. Persist the score, actor, timestamp, and settlement count. Serialize prediction acceptance and finalization on the simulated fixture row. Use a row lock on PostgreSQL and a write transaction with a bounded retry on SQLite. Recheck kick-off and finalization status after obtaining the lock.
3. For a retry with the stored score, return the stored result without crediting again. Return a conflict for a different score. Roll back score, predictions, and balances together on failure. Show the stored result on the normal match surfaces.

**Validation.** Exercise a home win, away win, and draw. Check a losing pick, a winning payout, an identical retry, a conflicting score, rollback on a settlement failure, and concurrent finalization or prediction placement on SQLite and PostgreSQL.

**Exit.** Every accepted pick settles exactly once against a single durable score, with the results visible to users.

## Milestone 4 — User Management

1. Add GET /admin/users and GET /api/admin/users with a bounded page size and stable ordering. Return only the fields the page needs. Render search, pagination, accessible loading and error states, and a details or action area for the selected account.
2. Add separate APIs for account status, unlocking, and points adjustments. Require a reason for each mutation and record the actor, target, timestamp, action and before/after values. Deactivation takes effect on the next authenticated request. Unlock clears the failed-login count and lock timestamp. Disallow operations against admin accounts.
3. Use a signed integer delta for points changes. Preview the selected account, delta and resulting balance before confirmation. Apply arithmetic atomically against the current balance, rejecting stale previews and deductions that would produce a negative balance. If a legacy balance is already negative, allow credits toward recovery. Store the adjustment and audit entry together and use a unique request ID to make retries safe.
4. Update the table from the response and show the actual resulting balance. Keep search and pagination when an action completes. Render usernames, team names and reasons as plain text.

**Validation.** Test pagination and search, deactivation with an existing session, reactivation, unlock, positive and negative deltas, an insufficient balance, simultaneous balance changes, duplicate requests, and audit accuracy.

**Exit.** Admins can manage regular accounts and adjust points without losing a concurrent gift, stake or payout.

## Milestone 5 — Integration and handoff

1. Run a two-account smoke test from promotion through match creation, prediction, finalization, and points adjustment. Verify both navbar links at desktop and mobile widths, keyboard form operation, and direct page and API access for regular users.
2. Run targeted tests for authorization, matches, prediction settlement, and concurrent points writes. Verify provider routes and the token-protected settlement endpoint with their existing contracts. Reproduce any pre-existing fixture failures against the baseline before attributing them to this change.
3. Update README.md with admin provisioning and revocation, page usage, simulated match behavior, and operational notes. Reconcile this plan with the implemented endpoints and migration. Back up persistent data before the schema rollout and smoke-test an upgraded database before granting admin access.

**Exit.** The two admin workflows work end to end on an upgraded database, and the team has provisioning and operation instructions.

## Risks and decisions to confirm

- Shared points and leaderboard standings can be influenced by any admin who enters a simulated score or adjusts a balance. The proposed controls are visible simulation labels, no admin predictions on simulations, and attributable changes. Verify that simulated stakes and payouts appear in the shared balance and leaderboard during the two-account smoke test.
- A mistaken final score cannot be corrected from the proposed UI after settlement. The confirmation step should display both teams and the full score. A future correction flow would need to reverse and reapply the original transactions.
- Older registration and prediction test fixtures used the previous registration contract. The affected fixtures now submit valid credentials or assert the current validation response.

## Implementation and verification

- Admin setup uses the grant and revoke commands in README.md. The two pages are /admin/create-match and /admin/users. Their APIs are under /api/admin, and the official token-protected settlement endpoint remains available.
- SQLite passed all 44 tests. PostgreSQL passed the nine admin tests on a disposable instance, including schema upgrade, concurrent finalization, and simultaneous gift and adjustment requests.
- The Edge smoke test covered publishing and finalizing on desktop, keyboard account management at 390 pixels, and denied access for a regular account. This change has been verified locally.

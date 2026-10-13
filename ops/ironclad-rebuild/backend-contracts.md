# Backend preservation baseline

Audited source: `f2-shell-wbg3ja` at `0fa8126`. No production source, database, provider setting or stored data was changed during this audit.

The actual source is the F1/F2 foundation and shell. Later completion statements in AGENTS.md do not mean later code is present in this commit. Front Desk, Estimator, Agents, Jobs, Customers and Calendar web routes are placeholders. Foundation customer/property/job CRUD, search, pins, activities, tasks, approvals, company/team settings and authentication are present.

## Contracts every UI task preserves

- Route URLs and deep links, authentication links, `/approvals/:taskId`, `/storm/plans/:taskId`, settings tabs, isolated route errors and map failure handling.
- `apps/web/src/api/client.ts`: same-origin credentials, cancellation, JSON bodies, ApiError fields/status/latest, unauthorized redirects and auth-specific redirectOn401 behavior.
- `apps/web/src/api/hooks.ts`: login/logout cache clearing; company switch navigation and query reset; removal of old-company pins, selection and private content.
- `apps/web/src/api/types.ts`: existing wire types and backend-provided hidden fields. No guessed values, fixture data disguised as real data, or imports of server/database implementations into web.
- Approval API/polling/step conversion: versioned approval payloads, owner/office/rep permissions, optimistic rollback, 409 reconciliation, query invalidation, queued/running polling, decline/retry/rerun and pending locks.
- Map bounding box order `[west,south,east,north]`, point/cluster distinctions, service area, search targets, weather states and no-network test mode.
- Today acknowledgment and company-local greeting; company/team mutation invalidation, last-owner protections and self-demotion effects.
- All backend, worker, database, provider adapters, migrations, shared business enums and send-gate code remain outside cosmetic task ownership.

## Verification boundaries

Use the existing focused web/UI regression tests for company switch, auth, API client, approvals/review, settings/team, map resilience, route errors, phone navigation and search. Run typecheck, lint, CSS lint and web build. Docker-backed suites run only with Docker available; otherwise require real GitHub Actions Platform and E2E results before integration. The actual CI on this baseline has Platform, v1 and E2E jobs.

No test sends a real message, orders a paid report, calls a live paid provider or changes production data. Do not report an unavailable or unexecuted check as passed. Screenshots verify frontend appearance; they do not establish provider or backend readiness.

The owner requested GPT-6 Astra only for all new sessions and delegated coding work. This overrides older Claude staffing/model rulings. Original source and integration branches are preserved; task branches may be pushed, but no task merges or pushes main.

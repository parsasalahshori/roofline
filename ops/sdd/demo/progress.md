# Demo mode: progress ledger

Branch `demo-mode`, off `launch-integration` 2a3cbe5. The owner runs the demo live on a Mac: clone → one command → working demo (scope change from the controller, 2026-10-12 ~17:58 UTC: no recorded video).

## 2026-10-12

- **DEMO_MODE** (`apps/api/src/config.ts`): it forces FAKE_PROVIDERS and WEATHER_DISABLED, and email is logged only. It is refused with NODE_ENV=production unless DEMO_MODE_ALLOW_PROD=1 (unit-tested in `apps/api/test/config.test.ts`). `DEMO_DATABASE_URL_OWNER` is optional and read only by the storm simulation.
- **Seed** `apps/api/src/scripts/demo-world.ts` (`seedDemoWorld`, `seed:demo -- --world`): Summit Ridge Roofing.
  - Contents: 66 customers; 30 jobs in every stage; 4 measured roofs and 4 proposals (signed, sent, viewed, draft); a storm with 37 hits and a drafted plan; 5 Front Desk conversations (2 calls); 11 agent tasks (418 minutes saved); 1 open claim; 13 appointments; follow-up and weather drafts.
  - Idempotent: the second run changes nothing (`apps/api/test/demo-world.test.ts`).
- **Simulate**: `/api/demo` and `/api/demo/simulate/{text,call,storm,sign}` (`apps/api/src/demo/*`, `apps/api/test/demo-routes.test.ts`). The Demo badge and Simulate panel are in the top bar (`apps/web/src/features/demo/*`).
- **Runner** `npm run demo` (`scripts/demo.ts`):
  - Preflight: Node, Docker (dockerd fallback on Linux, `open -a Docker` on macOS) and ports.
  - Then: docker compose (`docker-compose.demo.yml`), migrations, seed, a web build with OSM tiles, and the API + worker.
  - Options: `demo:reset` for fresh data; `--db-only`.
  - A per-machine key is kept in the git-ignored `.env.demo`.
- **Ruling DM1**: the demo database uses `imresamu/postgis:16-3.4`, because `postgis/postgis:16-3.4` is amd64-only. Same PG16 and PostGIS 3.4, and multi-arch. The CI job `Demo DB (arm64)` (ubuntu-24.04-arm) proves it migrates and seeds on arm64.
- **Ruling DM2**: in DEMO_MODE the storm layer never reports stale (a demo has no hail feed).
- **Ruling DM3**: the demo seed is on the insurer-contact guard's allow list. It stores a fictional adjuster on the claim; its only send is a drafted texts step to seeded customers.
- **Mac**: `scripts/demo-mac.sh` and a one-liner (in `docs/demo.md`). It installs Homebrew, git, Docker Desktop and fnm/Node 22 (`.nvmrc`), then runs `npm ci` and `npm run demo`, and opens the browser. Shellcheck runs in CI. It has not been run on a real Mac.
- **Smoke**: `apps/web/e2e/demo-walkthrough.spec.ts` via `apps/web/playwright.demo.config.ts`, in the E2E job. It tours every app and runs all 4 simulations; any error screen or 5xx fails it. It passes locally and in CI (run 38290257518).
- **CI on 1a78f80**: E2E, arm64, Hail and v1 were green. Platform had 2 guard failures, fixed in 6e55f90.
- **CI green** on 6e55f90 (run 38295342812): Platform, E2E (incl. demo smoke), Demo DB (arm64), Hail, v1 all pass.
- **Signed PDF** (caveat 3): the DEMO_MODE file store is shared on disk (DEMO_FILES_DIR, `.demo-files/`). The seed renders the signed PDF; the sign simulation returns the homeowner link; the smoke test downloads the PDF. CI green on d657b2e (run 38303233078).
- **launch-integration re-merge**: held. 999d4c4, 1884f17 and 235ce30 were not green (235ce30: main E2E red). The merged tree passed the smoke test locally (branch demo-merge-wip, local only).
- **BUG-7** (4f6ab800): GET /api/demo is always mounted; it answers {demo:false} when demo mode is off. CI was green except the signed-pdf helper flake. My helper fix dcfcead8 was reverted (3bf442e2) in favour of E1 420f022 (cherry-picked). Sentinel takes 4f6ab800 only.
- **Launch merge**: bb23b03e (green) merged at 402b272a. Local checks all pass, smoke 2.5 min. One-liner (Linux path): the raw URL serves the branch script, and fresh clone + npm ci + npm run demo seeds and logs in. The Mac steps need an owner dry run.
- **Final launch head** ff772d5c merged (G1 Ruling BL expiry, C1 phone top bar, S1 a11y, A1 paused-mid-ring). Locally all checks pass, smoke 2.5 min. `map-est-demo` 86615b29 handed to the controller (demo-lift comes separately).

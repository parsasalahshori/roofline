# PROGRESS
goal: Audit Roofline / WinChoice (real-lookups a853db03), fix confirmed defects, deploy everywhere it runs
      (Mac 4600 + 4500, Render roofline-api + DB migrate, Vercel roofline-measure, TestFlight WinChoice).
green:
  - npm run typecheck && npm run lint: clean
  - vitest shared / web / api / db: 0 failures except the 3 known (front-desk stats 'today' x2, approvals EPIPE), or those fixed
  - npm run build -w @roofline/web (includes check-build-preload)
  - roof bench: all gates pass vs ~/RooflineWork/roof-bench/baseline-v4-alg6.json + gates-v3.json
  - iOS: Core scripts/check.sh 0 failures; XCTest WinChoiceTests+WinChoiceCoreTests 0 failures; AccessibilityAuditTests 0 failures
  - every audit finding marked P0/P1 is fixed with a test that failed before, or listed under needs-me with why
  - after deploy: 4600 + Render answer /api/public/homeowner/winchoice/company 200 on the new commit; built web app looks styled;
    simulator walk of the homeowner flow reaches Get my estimate
metric: open P0/P1 findings (target 0)
fence: this worktree (branch audit/2026-11-14); deploy targets only after green
never: no attribution lines in commits; no force-push; no data deletion; no paid data; no new accounts; keys never printed;
       Sonnet agents xhigh at most; never touch ~/roofline-demo working tree except the final ff merge
budget: 2 audit agents + at most 2 fix agents; one full suite at the end

## findings
| id | sev | area | finding | status | evidence |
|----|-----|------|---------|--------|----------|
| A1 | P1 | api | Back-office import turns quote-grade homeowner/room-scan windows into designs marked measured ("On site" on the factory PDF) | fixed | backoffice/import-measured.ts:90 |
| A2 | P1 | api | No cap on scans per window/request or on scan-refine jobs (COLMAP/SAM cost, review-queue spam) | fixed | public/homeowner-scans.ts:144 |
| A3 | P1 | api | Homeowner API has no human/device check (fake leads, booking every slot) | needs-me (Turnstile/App Attest is a product decision) | public/homeowner.ts:404 |
| A4 | P1 | api | Debug capture dump: no total cap, captureId not scoped to the request | fixed | public/homeowner-detect.ts:185 |
| A5 | P1 | deploy | CONFIRMED via Render API: only roofline-api runs online, no worker -> Google 30-day cleanup, signed PDFs, follow-ups never run on Render | fixing at deploy (run the worker in the same container) | Render services list |
| A6 | P1 | api | 90-photo cap per request can run out mid-flow with many scanned windows; deleting a window frees nothing | fixed (13 frames/window; caps 400 photos, 400 MB) | shared/homeowner.ts:23 |
| B1 | P2 | api | quote_estimates keeps Solar-derived data past 30 days | fixed | quote/estimate.ts:269 |
| B2 | P2 | api | Re-measured window keeps confirmed:true | fixed | shared/window-order.ts:535 |
| B3 | P2 | api | Same-stage move sends duplicate customer texts/emails | fixed | routes/backoffice.ts:420 |
| B5,B9 | P2 | api | Turnstile half-configured is silent; /p/<token> not scrubbed from logs | fixed | config.ts:154, errors.ts:139 |
| B4,B6,B7,B8 | P2 | api/web | expired-request photo sweep; per-process rate limits (keep 1 instance); logo CSP; Maps key restriction | needs-me / nice-to-have | audit report |
| F1 | P0 | ios | Release build has no server (server.release ""): unreachable until a tester types one; isTesterBuild true | fixed | WinChoice.json:8, Brand.swift:109 |
| F2 | P1 | ios | Rep app does not compile: ScanShot lives under Homeowner/ which the rep target excludes | fixed | project.yml ~140 |
| F3 | P1 | ios | A failed window has no Retry in the UI and Get my estimate files the lead without it | fixed | ListScreen:131, HomeownerStore:652 |
| F4 | P1 | ios | 401/404 on contact/book wipes all measured windows (keepWindows false) | fixed | HomeownerStore+Journey:192 |
| F5 | P1 | ios | Saved session with old services (roof/gutters) fails to decode -> request silently lost | fixed | Homeowner.swift:1094 |
| F6 | P1 | ios | setStyle offline leaves a duplicate window | fixed | HomeownerStore+Windows:300-411 |
| F7 | P1 | ios | Adding a window after booking files a second contact instead of returning to My order | fixed | HomeownerStore+Windows:411 |
| F8 | P1 | ios | Privacy manifest lacks SystemBootTime reason (systemUptime used) | fixed | PrivacyInfo.xcprivacy, RoomHybridCamera:252 |
| F9-F13 | P2 | ios | quote/price wording left, start-over alert vs adoption, corrupt outbox swallowed, idle timer during scans, deletion wording | fixed (F9,F11,F12); F10,F13 for owner | audit report |

## dead ends / known
- Known failing before this run: front-desk stats-routes 'today' x2 (time-dependent), approvals-approve EPIPE.
- Deployed everywhere = a287de2c (Oct 26). Head a853db03 adds 2 iOS-only commits (TestFlight state unconfirmed).

## log (EXPECTED vs SAW)
- 2026-11-14 start: baseline suites running (logs ~/RooflineWork/logs/audit-baseline.log).
- baseline: typecheck/lint/web build OK; shared 2071, web 2672 pass. api EXPECTED 3 known failures, SAW 12: 7 google-retention + 2 roof-3d new.
  Cause: createMeasurement/updateMeasurement read back with the real clock; fixture date + 30 days passed on Nov 11. Fixed bf47d4e1 (20/20).
- ios fixes merged (audit/ios-fixes 43419e51): 217 core checks, 174 unit, 16/16 audits, rep app builds.
- server fixes merged (audit/server-fixes 88b76bea): migration 0050_window_scans_delete_grant; tests per finding.
- size cap raised to 400 MB (b72380d2). Full suite running: ~/RooflineWork/logs/audit-final.log

## next
- full suite green -> ff real-lookups (autosync pushes) -> Mac 4500/4600 -> Render (image + migrate 0050 + worker in container) -> Vercel -> TestFlight -> verify

## status
state: in-progress
needs-me:

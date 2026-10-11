# Roofline
- **What is where:** `v1/` is the original single-company estimator (React + Express + SQLite); `packages/` (`shared`, `db`, `send-gate`) and `apps/` (`api`, `worker`) are the multi-company platform as npm workspaces that export TypeScript source (no build step); specs and plans live in `docs/superpowers/`.
- **Run v1:** `cd v1 && npm install && npm start`, then open http://127.0.0.1:4311 (v1 keeps its own `package.json`, `.env` and `data/`; see `v1/README.md`).
- **Run the platform tests:** `npm install`, then `npm test` (Vitest); `npm run typecheck` and `npm run lint` are the other checks, and `npm run db:up` starts the local PostGIS database (needs Docker).
- **Run v1's tests:** `cd v1 && npm test` (node:test) and `npm run test:e2e` (Playwright).

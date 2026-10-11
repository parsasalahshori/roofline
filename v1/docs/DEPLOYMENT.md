# Deployment and operations

The delivered app is running locally; no domain, cloud account or external deployment has been created. The Dockerfile is supplied but container execution was not verified in this environment.

## Local company use

Use Node 22.13+, `npm ci`, `npm run build`, then `npm start`. Bind to loopback. Set `DEMO_MODE=false` and real admin credentials before using customer data. A separate fresh `DATABASE_PATH` avoids mixing demo records with business records. Keep the process running for automatic report checks. Browser sessions are invalidated on restart.

## Remote company installation

Deploy one app process with durable SQLite storage behind a TLS reverse proxy. Set production mode, disable demo, set a long unique admin password and optional CLI token, and expose only through the authenticated HTTPS endpoint. Rate-limit and log safely at your proxy. Do not expose debug/development servers, `.env`, the database directory or BuildCLI working files.

Example image build: `docker build -t roofline .`. Run with your secret environment file and mount persistent storage at `/app/data` writable by container UID 1000. The image intentionally refuses production startup without valid admin credentials. Secure cookies need HTTPS at the external origin, including for a Docker deployment on a workstation.

The application serves frontend and API from the same origin; cross-origin mutation requests are rejected. The development Vite proxy is for local development only. CSP allows only local scripts; the static map proxy retains image attribution. Define your own company terms/privacy notices and provider contractual permissions before public Google Maps use.

## Data and recovery

SQLite WAL is enabled. Back up via a SQLite backup utility or stop the service before copying database files. Do not copy a live main `.sqlite` file alone and assume it contains uncheckpointed WAL writes. Quote snapshots contain customer contact data, measurement source, scope, rates and company information. PDF/JSON downloads are private endpoints and contain the same sensitive business data.

Paid orders transition to `ordering` before an external call. `attention` or an interrupted `ordering` state must be reconciled in EagleView using the recorded reference ID; do not blindly resubmit. Successful report completion and draft creation share one database transaction. Active API tokens and provider credentials are supplied through environment/secret management, never the browser.

## Scaling boundary

This app intentionally has one company, one owner role, one SQLite database and one worker process. Do not horizontally scale it against the same database: session invalidation, rate limiting and job locking are designed for a single process. A public SaaS expansion needs tenant isolation, proper user/role management, persistent distributed jobs, object storage, observability, backup/restore drills, provider OAuth refresh, support tooling and service-specific contractual review.

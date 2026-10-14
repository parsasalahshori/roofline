# Run the demo on your Mac

A working demo of the whole app — CRM, Estimator, Storm Scout, Front Desk, the Agents screen and
the Claims, Scheduler and Follow-up agents — on your own Mac, with **no real accounts**. Every
outside service (texting, calls, email, AI, aerial measurements, ads, calendars, payments, file
storage) is replaced by a fake inside the app, so nothing is sent, called or charged. All the data
is made up.

## The quick way: one line

1. Open **Terminal** (press ⌘ Space, type `Terminal`, press Return).
2. Paste this line and press Return:

   ```sh
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/parsasalahshori/roofline/demo-mode/scripts/demo-mac.sh)"
   ```

3. Wait. The first time takes 5 to 15 minutes. Along the way:
   - if Homebrew is not installed, macOS asks for **your Mac password** once (type it and press
     Return; nothing shows while you type);
   - Docker Desktop opens the first time: click **Accept** on its terms (you can skip signing in).
4. Your browser opens at **http://localhost:4500**. Sign in with:

   | | |
   |---|---|
   | Email | `owner@summitridge.test` |
   | Password | `summit-ridge-demo` |

   (A demo-only login for the demo's own throwaway database.)

The script is safe to run again: it skips whatever is already installed, so the next time it takes
about a minute. It installs only what is missing: Homebrew, Docker Desktop, git, and Node 22 (through
`fnm`, from the repository's `.nvmrc`). It does not use `sudo` itself and does not change your shell
profile. The code goes into `~/roofline-demo`.

### A frozen demo build

For a specific, frozen demo branch (for example `demo-oct13`), name it twice in the one line:

```sh
ROOFLINE_DEMO_BRANCH=demo-oct13 bash -c "$(curl -fsSL https://raw.githubusercontent.com/parsasalahshori/roofline/demo-oct13/scripts/demo-mac.sh)"
```

If `~/roofline-demo` already exists on another branch, the script switches it to the frozen branch and starts
from fresh demo data (`npm run demo:reset`). From a clone: `git checkout demo-oct13 && npm ci && npm run demo:reset`.

## Step by step (if you prefer)

1. Install **Docker Desktop**: https://www.docker.com/products/docker-desktop/ (pick Apple Silicon or
   Intel to match your Mac: Apple menu → About This Mac → Chip). Open it once and wait until it says
   "Engine running".
2. Install **Node 22**: https://nodejs.org/en/download (the macOS installer), or with Homebrew:
   `brew install fnm && fnm install 22`.
3. In Terminal:

   ```sh
   git clone https://github.com/parsasalahshori/roofline.git
   cd roofline
   git checkout demo-mode
   npm ci
   npm run demo
   ```

4. Open **http://localhost:4500** and sign in with the login above.

`npm run demo` checks Node, Docker and the ports first and says how to fix anything missing. It then
starts the demo database in Docker (PostGIS, which runs natively on Apple Silicon and Intel), sets it
up, fills it with the demo company, builds the web app the first time, and starts the app.

## Using the demo

- The company is **Summit Ridge Roofing**, a made-up roofer in Omaha: customers and jobs in every
  pipeline stage, measured roofs and proposals (one sent, one signed), a recent hail storm with
  matched properties and a drafted plan, Front Desk texts and two calls with transcripts, agent work
  with minutes saved, an open insurance claim, appointments, follow-up drafts and calendar events.
  Dates are relative to when the demo was set up, so it looks current.
- The small **Demo** badge in the top bar opens the **Simulate** panel:
  - **Homeowner texts in**: a homeowner's text reaches Front Desk, which answers it.
  - **Incoming call**: a scripted caller rings; Front Desk answers, and the call lands with a
    transcript and a summary.
  - **Hail storm hits**: a new storm crosses the service area; Storm Scout shows the swath and the
    matched properties.
  - **Homeowner signs proposal**: the newest sent proposal is signed, as if from the homeowner's
    phone.

## Stopping and resetting

- **Stop**: press **Ctrl+C** in the Terminal window. Your demo data is kept for next time.
- **Start again**: `npm run demo` (in the `roofline` folder, or `~/roofline-demo`), or run the one
  line again.
- **Fresh data** (do this the morning of a demo, so "last night's storm" is last night):
  `npm run demo:reset`. It throws the demo database away and seeds it again.
- **Port in use?** Another demo is probably running in another window; stop it, or use another port:
  `DEMO_PORT=4600 npm run demo`.

## Five-minute presenter script

**0:00 — Sign in (20 s).** "This is Summit Ridge Roofing, a made-up roofing company. Everything you
see is fake data, and nothing leaves this laptop." Sign in; point out the Demo badge.

**0:20 — Today and the map (40 s).** "The day starts here: what needs a yes, who called, what's on
the calendar." Close Today. "Every customer and open job is a pin on the map; the colours are
pipeline stages."

**1:00 — CRM (45 s).** Open Jobs. "The pipeline, lead to paid." Open a job: the customer, the
address, the timeline of every text, call and stage change.

**1:45 — Estimator (45 s).** Open Estimator. "The roof was measured from aerial imagery, no ladder."
Open a proposal: the line items and the homeowner link. Point at the signed one. "Only one side
took hail?" On a measured roof, tap its facets on the photo (or the A, B, C buttons under **What to price**):
the squares and all three prices drop to just that part. **Whole roof** puts it back.

**2:30 — Storm Scout (45 s).** Open Storm. "Last night's hail, drawn from radar. These are our
customers inside the swath." Open the storm: matched properties and the drafted plan (texts, door
route, ads) waiting for a yes.

**3:15 — Front Desk (45 s).** Open Front Desk. "The AI front desk answers texts and calls 24/7."
Open a call: transcript and summary. Then Demo badge → **Homeowner texts in**, and show the reply
landing. Then **Incoming call**, and open the new call's transcript.

**4:00 — Agents (40 s).** Open Agents. "Each agent shows the minutes it saved this week." Show Claims
(the open insurance claim), Scheduler (appointments) and Follow-up (drafts waiting for a yes).

**4:40 — The finale (20 s).** Demo badge → **Hail storm hits**, then open Storm to show the new swath.
Then **Homeowner signs proposal**, and show it flip to signed. "From hail to a signed roof, and the
team only had to say yes."

## For developers

- `DEMO_MODE=1` wires every provider to its fake (it forces `FAKE_PROVIDERS` and `WEATHER_DISABLED`),
  logs email instead of sending it, shows the Demo badge and mounts `/api/demo/*`. Startup
  **refuses** `DEMO_MODE` with `NODE_ENV=production` unless `DEMO_MODE_ALLOW_PROD=1` is also set, so
  a demo can never quietly replace real providers.
- `npm run demo` is `scripts/demo.ts`; the database is `docker-compose.demo.yml`
  (`imresamu/postgis:16-3.4`, multi-arch, port 54339, its own volume). On Linux it starts `dockerd`
  in the background when Docker is not running. `--db-only` stops after the seed.
- The seed is `apps/api/src/scripts/demo-world.ts` (`npm run seed:demo -w @roofline/api -- --world`);
  it changes nothing when the company already exists.
- The smoke test, `apps/web/e2e/demo-walkthrough.spec.ts`, tours every app and runs each simulation:
  `npx playwright test -c apps/web/playwright.demo.config.ts` (it starts its own demo on port 4510).
  CI runs it in the E2E job, and checks the database and seed on arm64 in the `Demo DB (arm64)` job.

# Roofline roadmap

Written 2026-10-12 by Architect 2. The plans in `docs/superpowers/plans/` hold the details; this page gives the order, dependencies, a rough build time, and what the owner must do before each part can go live.

## Order and dependencies

| # | Milestone | Plan | Tasks | Depends on | Status (2026-10-12, late) | Rough build time |
|---|---|---|---|---|---|---|
| 1 | **F1** Platform core | `2026-10-10-roofline-f1-platform-core.md` | 19 | — | done | — |
| 2 | **F2** Shell and design kit | `2026-10-11-roofline-f2-shell.md` | 17 + P1 | F1 | merged; only the final-review fix task T19 left (briefs in `ops/sdd/f2/`) | — |
| 3 | **F3** Setup, texting, billing | `ops/sdd/f3/` briefs | 37 | F2 | in progress: 23 of 37 merged (briefs in `ops/sdd/f3/`) | ~1 day |
| 4 | **C1** Core CRM | `2026-10-12-roofline-core-crm.md` | 29 | F3 | planned; briefs ready (`ops/sdd/c1/`) | ~2 days |
| 5 | **E1** Estimator and homeowner page | `2026-10-12-roofline-estimator.md` | 22 | C1 | planned; briefs ready (`ops/sdd/e1/`) | ~1.5 days |
| 6 | **S1** Storm Scout (includes the Python hail service) | `2026-10-12-roofline-storm-scout.md` | 29 | E1 | planned; briefs ready (`ops/sdd/s1/`) | ~2–2.5 days |
| 7 | **D1** Front Desk | `2026-10-12-roofline-front-desk.md` | 27 | S1 (by branch; really C1 + F3) | planned; briefs ready (`ops/sdd/d1/`) | ~2–2.5 days, plus real-call tuning |
| 8 | **A1** Agents screen | `2026-10-12-roofline-agents-screen.md` | 13 | D1 | planned; briefs ready (`ops/sdd/a1/`) | ~1 day |
| 9 | **G1** Claims, Scheduler, Follow-up (next release) | `2026-10-12-roofline-more-agents.md` | 18 | A1 | planned; briefs ready (`ops/sdd/g1/`) | ~1.5 days |

- **Launch = F1–F3, C1, E1, S1, D1, A1** (master §4). G1 is the next release.
- **Branch chain:** each integration branch starts from the previous one (`c1-crm` ← F3, `e1-estimator` ← C1, `s1-storm` ← E1, `d1-front-desk` ← S1, `a1-agents` ← D1, `g1-agents` ← A1). D1 needs only C1 and F3, so it could run alongside E1/S1 on a second team if one becomes free. That would need its own migration numbers; ask the controller before doing it.
- **Every plan has task briefs** (`ops/sdd/<milestone>/task-N-brief.md`, `global-constraints.md`, `progress.md` with the pre-flight scan and rulings). Briefs for C1 onward name upstream exports from plans not yet built, marked [C1]/[E1]/[S1]/[D1]/[A1], to be checked against the merged code when each task starts.
- **Build time** is wall-clock at the pace seen so far: F2's 17 tasks took about 14 hours with three teams, which is roughly 1.2 tasks per hour. The estimate covers about 12 working days for F3 through G1. Manual smoke tests and owner lead times (below) usually take longer than the building.

## Owner to-do list (what blocks going live)

Start the long-lead items now. Approvals for texting, Google, Meta and EagleView take weeks.

### Accounts and credentials

| Item | Lead time | Blocks going live |
|---|---|---|
| Postmark server, sending domain DNS (SPF/DKIM/Return-Path) | days | F1 (login emails) |
| Stripe account, products and prices (plan sync script) | days | F3 |
| Twilio ISV account, A2P 10DLC, **Roofline's own brand**, privacy and terms URLs | 10–15 days per roofer brand | F3 (texting), S1 team SMS alerts later |
| Domains: app, branded short links, mail sending | days | F3 |
| MapTiler and Geocodio accounts | same day | F2/F3 (map, geocoding); S1 reverse geocoding; G1 static maps (confirm quota) |
| Google Cloud OAuth verification (Calendar scope) | can take weeks; unverified apps are capped at 100 users | C1 (Google Calendar sync) |
| Microsoft Entra multi-tenant app and publisher verification | days | C1 (Outlook sync) |
| **EagleView partner agreement** and API credentials | commercial negotiation | E1 (exact reports) |
| Cloudflare R2 bucket and keys | same day | E1 (signed PDFs), D1 (recordings) |
| **Google Ads manager account and a developer token with Basic access** | about 2 business days | S1 (Google ads) |
| **Meta app: Business Verification, Advanced Access for ads_management/ads_read, a system user** | days to 2 weeks | S1 (Meta ads) |
| Postmark **broadcast** stream | same day | S1 (storm emails) |
| Second Render worker for the hail service, and an ops alert email | same day | S1 |
| **Anthropic organization, production key, rate tier and spend limits** | same day | D1 (also G1 drafting) |
| Twilio voice on subaccounts, **ConversationRelay enabled, AI/ML addendum accepted**, and a Roofline test caller number | days | D1 |
| Test phones on Verizon, AT&T, T-Mobile and a landline/VoIP line | — | D1 (forwarding codes) |
| **Voice choice for the phone front desk**: pick the ElevenLabs voices Twilio ConversationRelay should use (the code has placeholder voice ids) | same day | D1 (voice calls) |

### Money and pricing decisions

| Decision | Blocks |
|---|---|
| Plan prices and allowances; the EagleView markup | F3 / E1 |
| **AI-minute price** must cover about $0.10–0.12 per minute | D1 |
| Hail worker hosting, about $7–25 per month | S1 |
| Default storm ad budget ($270 over 7 days) is acceptable | S1 |
| Time-saved baselines and the $28/hour default | A1 |
| After measuring latency: Opus fast mode (twice the price) or not | D1 tuning |
| Zero data retention with Anthropic: request it or not | D1 |
| Spanish for Front Desk; standing approvals for agents | after D1 / G1 |

### Lawyer review

| Topic | Blocks |
|---|---|
| Terms of service, privacy policy, the texting consent confirmation, TCPA practices | F3 |
| E-sign consent and the signed-record format | E1 |
| Storm text and email wording, the landing-page consent checkbox, ad claims | S1 |
| **Whether roofing counts as Meta's Housing category** | S1 (Meta ads default) |
| Call recording and AI disclosure, retention periods, AI processing in the privacy policy, missed-call text-back, the team's recording acknowledgement | D1 |
| Claims agent boundaries (public-adjuster laws, deductible rules), review requests treated as marketing, claim-nudge wording | G1 |

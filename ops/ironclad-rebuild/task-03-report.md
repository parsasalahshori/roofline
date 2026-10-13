# Task 03 — Front Desk inbox, conversations and settings

## Branch and source

- Branch: `codex/ironclad-full-ui-03` only.
- Implementation commit: `32189059cb389bbc9cdb040ed90e81894268aae5`.
- Exact preparation source: `81b9251490cfa05eac4baecc68f6952b549a1460` fetched from `origin/codex/ironclad-full-rebuild`.
- Complete application base verified as an ancestor: `ff772d5cbf87eac051759e9049fb29930845a45f`.
- Initial checkout was clean on old `work` at `46c6e1f`. No reset, discarded changes, merge, main/integration push, force-push, dependency change, or lockfile change occurred.
- Bootstrap and Docker used the supported per-command network permission. Proxy and network policy were preserved. `npm ci --cache /tmp/roofline-task03-npm --loglevel=error` succeeded after the default home cache proved unwritable. No credential changes were needed.

## What changed

The desktop inbox now has a 369px maximum list beside a conversation pane, compact real weekly totals, segmented filters, recognizable caller avatars, selected-row highlighting, and distinct outcome colors. Opening the inbox presents an intentional selection prompt and sends no read receipts. Clicking a conversation keeps its normal `/front-desk/:id` URL and passes only the selected filter as navigation context. No conversation content or customer data is stored in route state. Direct deep links retain independent detail loading and have a Back to inbox action.

A selected conversation shows its name/phone, summary, permitted recording controls, team-handling switch, callback/spam actions and chronological transcript. The summary is above the transcript. A single linked job gets an Open job shortcut; every existing action-card link remains. Native audio continues to load only after Play recording and continues using the same authenticated recording route. No invented waveform, call timer, answer-time metric, or simulation button was introduced.

On phones the statistics strip scrolls horizontally, filters have 40px touch targets, the inbox takes the available width, and explicit selection switches to the detail view with reachable Back to inbox navigation. Replies are keyed to the selected conversation so unsent drafts cannot appear in another thread. Inbox summaries are accessible descriptions, separate from the link's name, to avoid confusing a summary mentioning “call back” with the actual callback action.

Settings retain the existing form and add clear sections: Answering calls and texts; Your assistant; What the assistant can do; Call limits and privacy. Forwarding codes, on-call ordering, and the personal transfer-phone form use neutral cards and responsive layouts. All underlying form validation and mutation payloads remain unchanged. Transfer recording acknowledgment remains unchecked on load and after save.

## Frozen workflows and boundaries

- No backend, database, provider, worker, send-gate, HTTP hook, contract/type, business-helper, routing, shared export, configuration, or dependency files changed.
- Real list filters, paging, live/idle polling, unread counts, read receipts and mutation invalidations remain in the original hooks. Background polling remains off.
- Role-restricted weekly statistics are still never requested for reps. Recording access and `canReply` remain server-controlled. Spam remains owner/office only.
- Staff reply and Team is handling remain separate mutations. Send-gate failures preserve the draft; scheduled messages retain their existing status copy. No real messages or phone calls were sent.
- Settings retain number/forwarding prerequisites, owner override confirmation, on-call order, retention explanations, turn-off availability and server billing restrictions. No blanket read-only wrapper was added.
- Company session/cache handling, approval pending/version/conflict behavior, public consent/signing, and demo/live isolation were not edited.

## Reference and visual evidence

Read and visually inspected the committed `front-desk-1440x900.jpg` and `front-desk-phone-390x844.jpg` plus `reference/README.md` and `front-desk-metrics.json`. Reference values used: near-white `#f6f7f8`, graphite `#151c22`, approximately 369px inbox, compact 13–14px content/labels, 20px conversation name, pale yellow assistant summary/bubbles, pale gray caller bubbles, blue selected row, and 16px inner cards. The 12px floor and phone targets remain.

Before/after browser captures were actually obtained at **1440×900** and **390×844** on the real isolated PostGIS/API/worker stack with fake providers and the repository's synthetic Front Desk fixtures. Before captures served an independently built Git archive of the exact preparation commit; after captures served this task's web build. No synthetic values were inserted into application code.

Local evidence is under `/workspace/work/ironclad-task03/task03-evidence/` (not committed: the task's exclusive allowlist permits source, its test and this report, not image assets):

- `before-inbox-*`, `after-inbox-*`
- `before-conversation-*`, `after-conversation-*`
- `before-settings-*`, `after-settings-*`
- `before-forwarding-*`, `after-forwarding-*`
- `before-profile-*`, `after-profile-*`
- Each `*` above is `1440x900.png` or `390x844.png`.
- `after-phone-reply-390x844.png`: visible phone reply form with an unsent draft; no send action.
- `visual-checks.json`: window dimensions and overflow observations. Desktop: client/scroll width both 1278px; phone: both 390px. No horizontal overflow at the window level.

Images reviewed include before/after desktop conversation, after phone inbox/conversation/settings/forwarding/profile. Review found and corrected a missing glyph fallback (now SVG), a switch-thumb contrast issue (feature-local teal switch accent), and excessive summary padding. Reference screenshot data are visual guidance only, never application data or functional evidence.

## Verification

| Check | Result |
| --- | --- |
| Baseline scoped web suites `d1-t21`, `d1-t22`, `d1-t23`, `d1-t24`, `d1-t26` | 19 files, 120 tests passed before edits |
| Same existing suites plus `ironclad-full-03.test.tsx` | 20 files, 123 tests passed |
| Own new regression suite after final assertion/type correction | 3 tests passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run lint:css` | Passed |
| `npm run build:web` | Passed; existing large-chunk warning remains |
| `npm ls playwright-core` | Only 1.56.1 |
| `npx vitest run --project @roofline/api apps/api/test/front-desk` | Real Docker/PostGIS: 44 files, 723 tests passed |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts front-desk.spec.ts --project desktop` | 11 passed on the real isolated Docker/API/worker stack (1.1m) |
| `npx vitest run --project @roofline/api apps/api/test/read-only.test.ts apps/api/test/read-only-guard.test.ts apps/api/test/isolation.test.ts` | Real Docker/PostGIS: 3 files, 69 tests passed |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts phone.spec.ts --project phone` | 14 passed; 1 blocked at the public Storm company-host page (details below) |
| Before/after browser visual capture | 21 screenshots; desktop and phone; real isolated API stack, fake providers |
| Ownership and `git diff --check` | Passed; every committed source/test path belongs to key 03 |

The first E2E pass found an accessible-name collision after adding the split inbox (10 passed, 1 failed). The implementation was corrected by separating row label and summary description; the existing test was not edited or weakened. The final rerun passed all 11 scenarios, as recorded in the table. The new regressions cover no automatic read receipt, filter-preserving routed selection, callback link identity, no cross-conversation draft carryover, no simulated send, and independent deep-link/back navigation.

## GitHub CI

Actual push run for implementation SHA `32189059cb389bbc9cdb040ed90e81894268aae5`:

https://github.com/parsasalahshori/roofline/actions/runs/38334453700

Observed at **October 12, 2026, 7:01 PM America/Los_Angeles**:

| CI job | Actual status |
| --- | --- |
| v1 (node:test) | Completed, success |
| Demo DB (arm64) | In progress |
| Platform (lint, typecheck, tests) | Queued |
| E2E (Playwright) | Queued |
| Hail service (ruff, pytest) | Queued |

CI is **pending**, not green. Controller must wait for all five outcomes before integration. CLI `gh run list` was denied by the environment's API destination policy; the connected GitHub read tool successfully retrieved the actual run and jobs. No policy bypass was used.

A later report-only commit does not start a new run under the existing workflow paths filter; this report identifies the actual implementation run rather than claiming a docs-only push was tested.

## Integration requests and remaining gaps

1. **Task 01/controller:** integrate the shared window/header/dock/font redesign, then repeat matching-viewport captures. This isolated branch still has baseline shared geometry (1280px desktop window, old header/dock/font and warm shell). Reference outer window is 1400×766 at x20/y42. Task 03 does not override another owner's shell selectors. Feature-local neutral surfaces are ready for the shared shell.
2. **Task 01/controller:** review the shared Toggle token contract during integration. Task 03 uses a light teal accent locally on its switches so the existing dark thumb remains visible; regular primary buttons remain graphite. Preserve contrast if the shared Toggle implementation changes.
3. **Task 09:** the baseline phone Settings tab strip does not automatically reveal its active Front Desk/Profile tab when opened by deep link. Those tabs remain reachable by horizontal scrolling; active-tab scrolling belongs to the settings container owner.
4. **Controller/Task 10:** verify split-view selection and back/forward navigation in the assembled shell. Direct deep links deliberately load only their conversation; the split inbox is shown when entered from the inbox. No routing or shared export changes are required for this task.
5. Provider readiness is not claimed: real carrier forwarding, recordings/storage, live delivery, billing accounts and consent-sensitive provider smoke tests were not performed. Full-product readiness and exact integrated pixel fidelity are not claimed.
6. **Controller/Task 10/environment:** the broader phone suite's public Storm scenario (`phone.spec.ts`, “S1 pages do not scroll sideways”) was blocked before its inspection button could render. The synthetic company host `acme-roofing.roofline.test:4410` returned a page whose entire snapshot was “Domain forbidden”. This is not a passing assertion or proof about Storm layout. The remaining 14 phone scenarios passed. No Chrome flags, proxy, domain policy, or public Storm code were changed to bypass the restriction; real GitHub E2E remains pending.
7. **Controller:** the full GitHub CI run remains pending as itemized above. Local Front Desk tests do not establish that all five CI jobs passed.
8. Committed reference evidence contains inbox/conversation captures, not a Front Desk settings screen. Settings styling follows that measured visual system; there is no claim of pixel comparison to an unavailable settings reference.

## Files changed

- `apps/web/src/copy/front-desk-conversation.ts`
- `apps/web/src/copy/front-desk-inbox.ts`
- `apps/web/src/copy/front-desk-settings.ts`
- `apps/web/src/features/front-desk/ConversationRow.module.css`
- `apps/web/src/features/front-desk/ConversationRow.tsx`
- `apps/web/src/features/front-desk/ConversationView.module.css`
- `apps/web/src/features/front-desk/ConversationView.tsx`
- `apps/web/src/features/front-desk/ConversationWindow.module.css`
- `apps/web/src/features/front-desk/ConversationWindow.tsx`
- `apps/web/src/features/front-desk/FrontDeskWindow.module.css`
- `apps/web/src/features/front-desk/FrontDeskWindow.tsx`
- `apps/web/src/features/front-desk/RecordingPlayer.module.css`
- `apps/web/src/features/front-desk/ReplyBox.module.css`
- `apps/web/src/features/front-desk/SummaryPanel.module.css`
- `apps/web/src/features/front-desk/SummaryPanel.tsx`
- `apps/web/src/features/front-desk/WeekStats.module.css`
- `apps/web/src/features/front-desk/settings/ForwardingGuide.module.css`
- `apps/web/src/features/front-desk/settings/FrontDeskTab.module.css`
- `apps/web/src/features/front-desk/settings/FrontDeskTab.tsx`
- `apps/web/src/features/front-desk/settings/OnCallList.module.css`
- `apps/web/src/features/front-desk/settings/TransferPhone.module.css`
- `apps/web/src/features/front-desk/settings/TransferPhone.tsx`
- `apps/web/test/ironclad-full-03.test.tsx`
- `ops/ironclad-rebuild/task-03-report.md`

## Evidence fingerprints

- `before-conversation-1440x900.png` SHA-256: `689a419f7e2533d6f355346d0a38149d03a4c236fc3606a196a174f5202ab65d`
- `after-conversation-1440x900.png` SHA-256: `d7fe0470594602760e6b83362673b43abedc801d60a2933357d450de38a68767`
- `after-inbox-390x844.png` SHA-256: `f0492734d6b313cd01fbb052c5c76f1ef75347fc83f599a3ae76827992f56737`
- `after-settings-390x844.png` SHA-256: `34a735a72cf900e9e3fc82c81c65b2b093b5e31da789dfa4b7f9cc8ec86ce030`

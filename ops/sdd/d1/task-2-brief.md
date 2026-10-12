### Task 2: Shared guards, rules and consent states

**Base:** `d1-front-desk` after Task 1 is merged. Pure. Real: `packages/shared/src/time-zone.ts`. No C1/E1/S1 dependency.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 guards + sentence buffer; Builder 2 transfer, text-back, identity and limit rules; Builder 3 `recording-consent.ts` + tests.

**Files:** Modify `packages/shared/src/front-desk.ts`; Create `packages/shared/src/recording-consent.ts`; Test `packages/shared/test/{front-desk-guards,front-desk-rules,recording-consent}.test.ts`.

**Interfaces:**
```ts
export type GuardHit = 'price' | 'coverage' | 'damage';
export function guardSentence(s: string, ctx: { repName: string | null }): { text: string; hits: GuardHit[] };   // replacement sentences from spec §7.2; numbers in words ("two thousand dollars") caught
export class SentenceBuffer { push(token: string): string[]; flush(): string[] }   // releases whole sentences (., ?, !, or 140 chars at a comma/space); never splits "Dr." "St." "a.m."/"p.m." or decimals
export type TransferReason = 'asked' | 'leak' | 'danger' | 'angry' | 'trade_caller' | 'not_understood' | 'model_failure';
export function shouldTransfer(i: { intent: string; urgent: boolean; mood: 'calm' | 'upset' | 'angry'; askedForPersonCount: number; taskInProgress: boolean; failedUnderstanding: number }): TransferReason | null;
export function transferPlan(i: { reason: TransferReason; urgent: boolean; inWorkHours: boolean; onCall: { userId: string; phone: string }[] }): { mode: 'ring_all' | 'ring_each' | 'message'; targets: { userId: string; phone: string }[]; timeoutSeconds: 20 };
export function shouldTextBack(i: { callerTurns: number; secondsInCall: number; status: 'failed' | 'completed' | 'no_answer' | 'busy'; lineType: 'mobile' | 'landline' | 'voip' | 'unknown'; spam: boolean; textedBackLast24h: boolean; enabled: boolean }): boolean;   // spec Decision 11 (voip counts as textable only when Lookup says SMS-capable — treat 'voip' as false in D1)
export function turnLimit(i: { turns: number; minutes: number }): 'ok' | 'offer_person' | 'end';   // 40 / 25 → offer; 30 min → end
export function matchCaller(phoneMatches: { customerId: string; firstName: string; lastName: string; streets: string[] }[]): IdentityLevel;
export function verifyCaller(c: { lastName: string; streets: string[] }, said: { name: string; street: string }): boolean;   // case/punctuation-insensitive; street number optional; "Elm" matches "Elm St"
// recording-consent.ts
export const ALL_PARTY_STATES: readonly string[];   // CA, CT, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA (documented with a note: CT/OR/MI nuances; behaviour is the same everywhere — spec Decision 12)
export function stateForAreaCode(npa: string): string | null;   // static NANP table (US only)
export function consentRegime(i: { callerE164: string; companyState: string | null; transferState?: string | null }): 'all_party' | 'one_party';
export function disclosureGreeting(companyName: string): string;   // "Thanks for calling {Company}. I'm {Company}'s virtual assistant, and this call is recorded. How can I help?"
```

**Tests:**
- guard table (≥ 60 cases, both blocked and allowed — "we've been in business 20 years" passes; "$12,000", "twelve grand", "about 400 a square", "insurance will pay for it", "your roof is definitely damaged" blocked); sentence buffer edge cases; transfer rule table; text-back table; verification table; area code → state samples; disclosure contains "virtual assistant" and "recorded".

**Carries and rulings:**
- Guard replacement sentences are server text spoken to callers; keep them in `front-desk.ts` constants.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): Front Desk guards, transfer and text-back rules, recording consent states`

### Task 8: Send gate: textable numbers and refusal kinds

**Split:**
- Builder 1: `phone.ts` textability and its tests.
- Builder 2: the `adapter.ts` refusal kinds and the fake.
- Builder 3: the `decide.ts` contact rule and its tests.

**Files:**
- Modify: `packages/shared/src/phone.ts`, `packages/send-gate/src/adapter.ts`, `packages/send-gate/src/decide.ts`, `packages/send-gate/src/index.ts`
- Test: `packages/shared/test/phone.test.ts`, `packages/send-gate/test/adapter.test.ts`, `packages/send-gate/test/decide.test.ts` (extend each)

**Interfaces:**
- **Textability:**
```ts
export const TOLL_FREE_AREA_CODES: readonly string[] = ['800','833','844','855','866','877','888','900'];
export const NON_US_NANP_AREA_CODES: readonly string[];   // Canada + other NANP countries, listed below
export function textability(e164: string): 'ok' | 'toll_free' | 'not_us' | 'invalid';
```
  - `NON_US_NANP_AREA_CODES`:
    - **Canada:** 204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 431 437 438 450 460 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942
    - **Other NANP countries:** 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876
  - US territories (340 670 671 684 787 939) are `ok`.
- **Refusals:**
```ts
export const SMS_REFUSED: unique symbol = Symbol.for('roofline.sms.refused');
export class SmsRefusedError extends Error {
  readonly [SMS_REFUSED] = true; readonly permanent: boolean; readonly optedOut: boolean; readonly reasonPlain: string | null;
  constructor(message: string, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string });
}
export function isSmsRefusedError(err: unknown): err is SmsRefusedError;   // instanceof, or name === 'SmsRefusedError' && err[SMS_REFUSED] === true
export type OutboundSms = { companyId: string; to: string; body: string; sender?: { accountSid: string; messagingServiceSid: string } | null };
// FakeSmsAdapter gains: refuseNext(n: number, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string }): void
// and records `sender` on `sent` entries only when the text carried one.
```
- **`decide()` contact rule,** in order:
  1. no number → "No mobile number on file."
  2. do-not-contact or opted out → "This customer asked not to be texted."
  3. `textability`:
     - `toll_free` → "This is a toll-free number, which can't get these texts."
     - `not_us` → "This number is outside the US, so we can't text it."
     - `invalid` → "This isn't a mobile number we can text."

- [ ] **Step 1: Write the failing tests**
  - `phone.test.ts`:
    - `textability('+18005550100') === 'toll_free'`
    - `'+14165550100'` and `'+18765550100'` → `'not_us'`
    - `'+17875550100'` → `'ok'`
    - `'+14025550144'` → `'ok'`
    - `'+4402071234567'` → `'invalid'`
  - `decide.test.ts`:
    - a toll-free recipient → `{action:'block', rule:'contact', reason:"This is a toll-free number, which can't get these texts."}`
    - Canada → the outside-the-US reason
    - with company status `past_due` and a toll-free number → rule `billing` (order kept)
  - `adapter.test.ts`:
    - `isSmsRefusedError(new SmsRefusedError('x'))` is true
    - a look-alike `{ name: 'SmsRefusedError', [Symbol.for('roofline.sms.refused')]: true }` (as from a second copy of the package) is true
    - `new Error('x')` is false
    - `refuseNext(1, {permanent:true, optedOut:true, reasonPlain:'R'})` makes the next send reject with those fields
    - `sent[0]` has no `sender` key when none was given

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/send-gate --project @roofline/shared`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite** (the F1 batch and dispatcher tests must still pass). `npx vitest run && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(send-gate): textable US numbers only; permanent and carrier opt-out refusals`

---


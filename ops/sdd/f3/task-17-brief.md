### Task 17: Hosted privacy and terms pages

**Base:** `f3-setup` after Task 9 is merged. From T9: stubs `apps/api/src/public/policies.ts` (`policyPages(deps): Router`, mounted right after `helmet`, before `/health`) and `apps/api/src/public/policy-urls.ts` (`policyUrls(config, slug)`), config `POLICY_PAGES_DOMAIN` (bare lowercase hostname; `testConfig` sets `roofline.test`), `@roofline/db/system` allowed in `public/**`. From T1: placeholder `packages/db/src/system/policy.ts` (in the system barrel). Task 27 later calls `policyUrls`.

**Split:**
- Builder 1: `apps/api/src/public/policy-text.ts` (templates and escaping).
- Builder 2: `apps/api/src/public/policies.ts`, `apps/api/src/public/policy-urls.ts`, `packages/db/src/system/policy.ts`.
- Builder 3: `apps/api/test/policy-pages.test.ts`.

**Files:**
- Create: `apps/api/src/public/policy-text.ts`
- Modify: `apps/api/src/public/policies.ts`, `apps/api/src/public/policy-urls.ts`, `packages/db/src/system/policy.ts`
- Test: `apps/api/test/policy-pages.test.ts`
- Do not touch: `app.ts` (already mounted).

**Interfaces:**
```ts
// system/policy.ts
export type PolicyCompany = { name: string; legalName: string | null; street: string | null; city: string | null; state: string | null;
  zip: string | null; phoneE164: string | null; email: string | null; website: string | null };
export async function companyForPolicyPage(system: Db, slug: string): Promise<PolicyCompany | null>;   // by companies.slug (lowercased), any status
// public/policy-text.ts
export const POLICY_TEMPLATE_VERSION = 'draft-2026-10';
export function escapeHtml(text: string): string;            // & < > " ' → entities
export function privacyPolicyHtml(c: PolicyCompany): string;
export function termsHtml(c: PolicyCompany): string;
export function notFoundHtml(): string;                        // "We couldn't find that page."
// public/policy-urls.ts
export function policyUrls(config: Pick<Config, 'POLICY_PAGES_DOMAIN' | 'PUBLIC_BASE_URL'>, slug: string): { privacy: string; terms: string };
// public/policies.ts
export function policyPages(deps: AppDeps): Router;
```
- **Where the pages answer:**
  - `Host: <slug>.<POLICY_PAGES_DOMAIN>` — compare lowercased, port stripped; `<slug>` is exactly one label. `GET`/`HEAD /privacy` and `/terms`. Any other path on such a host → the 404 page.
  - Any host: `GET /policies/:slug/privacy` and `/policies/:slug/terms`.
  - Anything else (including the app host and `/health`) → `next()` untouched.
- **Responses:** `text/html; charset=utf-8`, `Cache-Control: public, max-age=300`; unknown slug → 404 with `notFoundHtml()` (same content type). Every company value is `escapeHtml`-ed. Phone shown as `(402) 555-0199` (`displayUsPhone` from `@roofline/shared`).
- **Pages:** full HTML documents (`<!doctype html>`, `<meta charset="utf-8">`, `<meta name="viewport" …>`, `<meta name="policy-version" content="draft-2026-10">`, a `<title>` with the company name, minimal inline-free markup — helmet's CSP forbids inline styles only via `style-src 'self' 'unsafe-inline'`, so a small `<style>` is allowed but keep it minimal).
- **`policyUrls`:** with `POLICY_PAGES_DOMAIN` → `https://<slug>.<domain>/privacy|terms`; else `${PUBLIC_BASE_URL}/policies/<slug>/privacy|terms`.
- **Privacy page** must contain, verbatim: "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes." and "Text messaging originator opt-in data and consent will not be shared with any third parties." plus the company's legal name (else name), address, phone and email when present.
- **Terms page** must contain, verbatim: "Message frequency varies.", "Message and data rates may apply.", "Reply STOP to opt out", "Reply HELP for help", "Carriers are not liable for delayed or undelivered messages." plus the company name.
- The text is a draft until the owner's lawyer reviews it (spec §9); say so in a comment at the top of `policy-text.ts`.

**Tests (`policy-pages.test.ts`)** — `makeTestApp`; requests with `supertest` `.set('Host', …)`:
- `test('privacy on the company host')`: `Host: acme-roofing.roofline.test`, `GET /privacy` → 200, `text/html`, both privacy phrases, "Acme Roofing", `Cache-Control: public, max-age=300`, `<meta name="policy-version" content="draft-2026-10">`.
- `test('terms carry the texting program terms')` → all five phrases.
- `test('the path form works on any host')`: `Host: app.roofline.test`, `GET /policies/acme-roofing/terms` → 200.
- `test('an unknown slug is a plain 404 page')`: both forms → 404 with "We couldn't find that page."; `GET /other` on the company host → 404 page.
- `test('company details are escaped')`: rename Acme (owner client) to `Acme <script>alert(1)</script>` → body has `&lt;script&gt;` and no `<script>alert`.
- `test('an uppercase host works and the app host passes through')`: `Host: ACME-ROOFING.Roofline.Test:443` → 200; `GET /health` with `Host: app.roofline.test` → `{ ok: true }`.
- `test('policyUrls')`: with the domain → `https://acme-roofing.roofline.test/privacy`; without → `https://app.roofline.test/policies/acme-roofing/privacy`.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(public): hosted privacy and terms pages per company`.

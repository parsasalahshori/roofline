# E1 whole-branch review: A. Public link, e-sign, proof of what was signed

Reviewer A, read-only, worktree `/home/user/wt/e1-review` at b1a4980 (diff `origin/c1-crm..HEAD -- apps packages`).
Scope: `apps/api/src/public/**`, `system/proposal-links.ts`, `repos/{proposal-public,proposals,stored-files}.ts`,
`estimator/{send-proposal,signed-pdf}.ts`, `proposals/pdf.ts`, `errors.ts` (pathForLog), auth/read-only public prefix,
`rate-limit.ts`, `apps/web/src/features/homeowner/**`, `0016_estimator_grants_rls.sql`.

Checked and found sound: token is 32 random bytes base64url, looked up only by its SHA-256 through the unique index
(`proposals_link_token_hash_uniq`) on the app_system pool. app_system has SELECT on exactly
(id, company_id, link_token_hash, status, valid_until). Everything after the lookup runs in `withTenant` for the resolved
company, and every query filters by `ctx.companyId`. The public view carries no unit prices, calculation or other
customer data. The token is never in a log line (`pathForLog` on the 500 path, no request logger, jobs carry no token).
No-store, no-referrer and noindex are set on the API responses. Signing is serialized by `FOR UPDATE` plus the unique
`proposal_signatures(proposal_id)` inside a savepoint. Nothing writes options of a non-draft. The link is minted once
(`octet_length = 0` guard), so a resend or signed proposal keeps it. Revise refuses a signed proposal, and replace never
touches a signed one. The PDF is stored privately (signed R2 requests) with its sha256 on the file row and the
signature, and the file row rolls back if attach fails. RLS is ENABLED and FORCED with `tenant_isolation` on all nine
tables, and the footprint grants are as stated.

---

## Critical

### A-C1. A malformed drawn signature crashes the worker, and the signed PDF is never produced
- **Where:** `apps/api/src/public/proposal-sign.ts:64-70` (the only check is the 4-byte `\x89PNG` magic), `:80` (stored),
  `:106` (signature committed with its hash); then `apps/api/src/estimator/signed-pdf.ts:31-39` and `apps/api/src/proposals/pdf.ts:259,273`
  (`doc.image(image, ...)`).
- **What goes wrong:** pdfkit decodes RGBA/alpha PNGs through png-js `decodePixels`, which calls async `zlib.inflate` and
  does `throw err` **inside the callback**. That throw is an uncaught exception, and the API/worker has no handler, so the
  process dies. pg-boss then re-delivers the `signed-pdf` job (retryLimit 4), and each delivery crashes the shared
  multi-tenant worker again, along with every other company's jobs in flight (texts dispatch, billing, polls). A PNG
  that is malformed in other ways throws synchronously (`Incomplete or corrupt PNG file`). That fails all 5 attempts, so
  the proposal stays signed with **no signed PDF ever**: no `pdf_sha256`, no homeowner email, and "isn't ready yet"
  forever.
- **Verified:** I ran pdfkit from the worktree's node_modules on (a) PNG signature + IHDR(colorType 6) + IDAT `notzlibdata`
  + IEND, which gave `UNCAUGHT incorrect header check` and the process exited, and (b) `\x89PNG` + junk, which gave a
  synchronous `Incomplete or corrupt PNG file`.
- **Trigger:** anyone holding an open link (the homeowner, or anyone the SMS was forwarded to) POSTs `/sign` with
  `drawnSignature` = base64 of such bytes. A buggy or truncated client upload does the same by accident.
- **Fix:** validate the image fully in the sign route, **before** the object put and the signature commit, and answer 400
  `DRAW_AGAIN` on any failure:
  1. Check the full 8-byte signature and that IHDR is the first chunk.
  2. Bound the size: width ≤ ~2000, height ≤ ~1000, bit depth 8, color type 2 or 6, interlace 0.
  3. Concatenate the IDATs, `zlib.inflateSync` with a `maxOutputLength` of `h*(1+w*4)`, and require exactly that length.

  A simpler alternative is to decode and re-encode server-side and store only the re-encoded bytes and their hash.
  Also run the same validation in `makeSignedPdf` before `renderProposalPdf`, so any already-stored bad image fails the
  job cleanly instead of crashing the process.

## Important

### A-I1. `document_sha256` hashes live company data that is never stored, so the proof cannot be re-checked and can pair numbers that do not belong together
- **Where:**
  - `packages/db/src/repos/proposal-public.ts:95,119`: `financingTerms` comes from the live `company_settings`.
  - `proposal-public.ts:122` and `:141`: the estimate clause comes from the live setting.
  - `packages/shared/src/proposals.ts:90-110`: `signedDocument` also hashes the live company name and phone and the
    property address.
  - `apps/api/src/public/proposal-sign.ts:99`: only the hash is stored.
  - `packages/db/src/repos/stored-files.ts:69-92` and `estimator/signed-pdf.ts:231-240`: the PDF re-reads the financing
    terms, the clause, the company and the address at render time.
- **What goes wrong:**
  1. `monthlyEstimateCents` is frozen on the option at build (`estimator/build.ts:117`), but the APR/term shown beside it
     is live. If the owner changes the APR (or clears financing) after sending, the homeowner page shows, and the
     signature hashes, e.g. "About $212/mo · 7.99% for 120 months" where $212 was computed at 9.99%.
  2. Spec §tamper evidence says anyone can check that the proposal data did not change. But nothing stores the canonical
     document that was hashed. Once the company edits its phone or name, or the address is corrected, recomputing from
     the database gives a different hash for an untampered signature.
  3. The PDF job reads the settings again when it runs, and runs again on every retry. The PDF can therefore print a
     clause or financing line different from what the hash covers.
- **Trigger:** owner edits Settings → Prices → Financing, or the company phone, between send and sign, or between sign
  and a PDF retry.
- **Fix:**
  - Snapshot at send: put `financing_apr_bps`, `financing_term_months` and `estimate_clause` on `proposals`, set
    with the sent status. Use the snapshot in `publicProposalView`, `publicProposalState`, `signedPdfSource`, and so in
    `signedDocument` and the PDF.
  - Persist the exact canonical JSON that was hashed. Either add a `document_json jsonb` column on `proposal_signatures`
    in a new migration (C1 owns 0013/0014, E1 0015/0016), or store a `companies/<c>/proposals/<p>/signed-document-<sha>.json`
    object written before commit like the PNG.
  - Render the PDF's signed facts from that stored document.

### A-I2. The homeowner HTML page `/p/<token>` is not `noindex` and is only `no-cache`
- **Where:** `apps/api/src/web.ts:50` (the page fallback sets `Cache-Control: no-cache` and no `X-Robots-Tag`), and
  `apps/web/index.html` has no `<meta name="robots">`. Only the JSON under `/api/public/proposals` gets
  `publicProposalHeaders` (`public/proposal-common.ts:25-30`).
- **What goes wrong:** global constraints ("Public page: … `noindex`") and spec §5 Privacy require noindex on the page.
  The URL that crawlers and link-preview bots actually fetch is `/p/<token>`, which carries the bearer credential.
  It is served indexable and cacheable-with-revalidation. Referrer-Policy is fine, because helmet's default
  `no-referrer` is global.
- **Trigger:** a homeowner pastes the link into a public post or forum, or any crawler follows it.
- **Fix:** in `serveWeb`'s `page` handler, when `/^\/p\//i.test(req.path)`, set `X-Robots-Tag: noindex, nofollow` and
  `Cache-Control: no-store`. Optionally have `HomeownerPage` add `<meta name="robots" content="noindex">`.

## Minor

### A-M1. Per-token limit exists only on `/sign`; view, decline and signed.pdf are per-IP only
- **Where:** `apps/api/src/public/proposals.ts` (no per-token limiter). `proposal-sign.ts:48-58` covers sign only.
- **What goes wrong:** spec §5 and the constraints say the public API is "rate-limited per IP and token". `POST
  …/view` writes a `proposal_events` row and bumps `view_count` on every call. A leaked link replayed from many IPs
  (60/min each) grows the table and the view counters with no per-link bound.
- **Fix:** add a per-token limiter (key `token:<sha256 hex>`, e.g. 120/hour) on `publicProposalRoutes`. Alternatively,
  make `view` idempotent per ip_hash per hour.

### A-M2. The plain link token is persisted in `messages.body` and shown to reps, which bypasses the owner/office-only "Copy link"
- **Where:** `estimator/send-proposal.ts:152-157` renders the link into the body (`bodyRendered`), and it is stored on the
  messages row. `packages/db/src/repos/timeline.ts:141-155` returns `m.body` in the job timeline to any member who can
  open the job, while `routes/proposals.ts` `GET /:id/link` is limited to `approve_message`.
- **What goes wrong:** the token, a signing credential, is stored in clear outside `link_token_encrypted`. A rep on the
  job can read the full link and open or sign as the homeowner, which the link endpoint's gate is meant to prevent.
- **Fix:** decide one way and make it consistent. Either accept the texting log as the record and drop the
  capability gate's premise (note it in the ledger), or store and display the body with the link redacted (keep
  `{link}` in the row and render it only at provider hand-off, including the dispatcher's scheduled path).

### A-M3. "Nothing edits a signed proposal" is enforced only in code
- **Where:** `packages/db/migrations/0016_estimator_grants_rls.sql:10-13` grants table-wide UPDATE on
  `proposal_signatures` and `proposal_options` to app_tenant.
- **What goes wrong:** any future repo bug can rewrite `document_sha256`, `total_cents`, `signer_name` or a signed
  option's prices, and nothing in the database refuses it.
- **Fix (new migration):**
  ```sql
  REVOKE UPDATE ON proposal_signatures FROM app_tenant;
  GRANT UPDATE (pdf_file_id, pdf_sha256, updated_at) ON proposal_signatures TO app_tenant;
  ```
  Also add a `BEFORE UPDATE` trigger on `proposal_options` that raises unless the parent proposal's status is `draft`.
  Extend `rls.test.ts` for both.

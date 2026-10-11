# HTTP API

Base: `/api`. JSON request/response unless PDF. Authenticate with the HttpOnly browser session, or `Authorization: Bearer <API_TOKEN>`. All private routes require authentication. Error envelope: `{ "error": "Actionable message" }`. Invalid input returns 400, unauthenticated 401, forbidden 403, unknown record 404, workflow conflicts 409, unsupported report geometry 422, rate limits 429, upstream failures 502, missing provider keys 503.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Public health check |
| GET | `/auth/config` | Public demo availability |
| POST | `/auth/login` | `{email,password}` → session cookie |
| POST | `/auth/demo` | Loopback demo session, only when enabled |
| GET / POST | `/auth/me`, `/auth/logout` | Session identity / revoke session |
| GET / PUT | `/settings` | `{company,pricebook}` |
| GET | `/connectors` | Key presence and setup guidance, no secrets |
| GET | `/demo-properties` | Fixed fictional measurements; empty in live mode |
| GET | `/example-report` | Normalized JSON template |
| POST | `/measurements` | Normalized measurement + `source: manual|import` |
| POST | `/lookup/geocode` | `{address}` → address candidates; not roof geometry |
| GET | `/lookup/satellite?lat=…&lng=…` | Authenticated Google image proxy |
| POST | `/lookup/property` | `{address}` → RentCast context |
| POST | `/lookup/eagleview` | `{reportId}` → persisted completed measurement |
| POST | `/estimate` | `{scope}` → calculated line items using current pricebook |
| GET / POST | `/quotes` | List / create draft |
| GET / PUT | `/quotes/:id` | Read / edit draft with its original pricebook |
| POST | `/quotes/:id/duplicate` | New draft using current company/pricing |
| PATCH | `/quotes/:id/status` | `{status}`: draft→ready→sent→accepted or declined |
| GET | `/quotes/:id/events` | Operator activity |
| GET | `/quotes/:id/pdf` | PDF proposal download |
| GET | `/quotes/:id/json` | Snapshot export |
| GET | `/customers` | Proposal-derived customer directory |
| GET | `/leads` | Saved map properties |
| POST | `/leads` | `{address}` from the published sandbox list → idempotent saved property |
| GET | `/storms/hail?date=YYYY-MM-DD` | Public NOAA reports for the requested date, accessed through the authenticated workspace |
| GET | `/followups` | Internal reminders, sorted by due date |
| POST | `/followups` | `{quoteId,dueDate,note?}` → saved internal reminder |
| PATCH | `/followups/:id` | Change `dueDate`, `note` and/or boolean `done` |
| GET | `/jobs` | Measurement order workflow state |
| POST | `/jobs/price` | Address/product/customer object → ten-minute priced order |
| POST | `/jobs/order` | `{priceId,acceptMaxPriceCents,idempotencyKey}` → paid order |
| POST | `/jobs/check` | Poll eligible waiting reports; completed reports create drafts |

Quote shape: `examples/quote-request.json`. New browser quotes also send `previewPricebook`; if it differs from current server pricing, create returns 409. API callers omitting it receive a draft with scope review reset. Monetary output is integer cents. The three review flags are operator attestations, not automated verification. Ready/sent/accepted proposals are immutable; duplicate to revise them.

Follow-up `quoteId` must be the UUID of a saved proposal. `dueDate` is a valid date-only `YYYY-MM-DD` value; `note` is trimmed and limited to 500 characters. PATCH requires at least one supported field. Completion can be reversed through the API with `done: false`. Reminders persist in SQLite across server restarts and have no outbound messaging or calendar side effects.

Automatic price request: `{street,city,state,zip,productId,deliveryId,includeGarage,changesInLast4Years,customer:{name,email,phone},material}`. State is a two-letter uppercase abbreviation; ZIP is five digits or ZIP+4. Product/delivery IDs come from your provider account. The UI offers documented residential products 1/3 and deliveries 8/4/7; entitlements and availability vary. The returned `id` becomes `priceId`. Send a fresh UUID as `idempotencyKey`, and reuse the same key after an uncertain response to the same submission. This endpoint places a paid provider order and must only be invoked after operator authorization.

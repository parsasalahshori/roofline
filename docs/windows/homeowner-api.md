# Homeowner API (the WinChoice phone app)

The contract between the homeowner's phone app and the server. Everything the app needs, signed out: no staff session,
no cookies. Types for every body are in `packages/shared/src/homeowner.ts` (`Homeowner*`); the code is
`apps/api/src/public/homeowner*.ts`. **Status: DRAFT 1 (endpoints and field names are final; the walkthrough output is
filled in from a real run at the end of this page).**

- Base: `/api/public/homeowner/:slug`. The slug is the company's instant-quote slug (demo company: `summit-ridge`). A
  slug that does not exist, or whose page is turned off, is a 404 on `GET /company` and `POST /requests`.
- JSON in and out (`Content-Type: application/json`), except the photo upload. Every answer is `Cache-Control: no-store`.
- Money is whole US dollars (integers). Sizes are inches. Times are ISO 8601 with a `Z`.
- Auth: `POST /requests` returns a **token**; every `/requests/:id/...` call sends `Authorization: Bearer <token>`.
  The token is 32 random bytes in base64url (43 characters). The server keeps only its SHA-256 hash, so a lost token
  cannot be recovered: start a new request. A token lasts **60 days** from the request. Keep `requestId` + `token` in
  the Keychain.
- Nothing personal goes in a URL. The only personal details are in the one `POST .../contact` body.

## Errors

Every error body is `{ "error": "<a sentence to show a person>", "field"?: "<body field>", "code": "<machine code>" }`.
Show `error`; switch on `code`. Status and code pairs:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | A field is missing or wrong (`field` names it). Includes a corner outside the photo, an `uploadId` that is not one of this request's photos, a bad `slotStart`. |
| 401 | `unauthorized` | No token, a malformed token, a wrong token, an unknown request id, or another company's request. **All look the same**, so request ids cannot be probed. |
| 401 | `token_expired` | The token is right but is past its 60 days. Start a new request. |
| 403 | `cross_site` | A browser sent an `Origin` that is not allowed. A native app sends none. |
| 404 | `not_found` | Unknown slug (or page turned off) on `GET /company` and `POST /requests`; a window id that is not on the request. |
| 409 | `window_id_taken` | `POST .../windows` with an id already used for a **different** window. |
| 409 | `windows_full` | The request already has 60 windows. |
| 409 | `uploads_full` | The request already has 90 photos or 250 MB of photos. |
| 409 | `callback_only` | A windows call (upload, window, delete) on a request that went to the call-back path (`status: "callback"`). |
| 409 | `windows_not_requested` | A windows call on a request that did not ask for `windows`. |
| 409 | `contact_needed` | `POST .../book` before `POST .../contact`. |
| 409 | `contact_filed` | `POST .../contact` again with a **different phone number**. The same phone is answered 200 with the request as filed. |
| 409 | `consent_changed` | `consentVersion` is not the current one: fetch `GET /company` again and show the new words. |
| 409 | `slot_taken` | The picked time is no longer open, or is not one the company offers. Fetch `.../slots` again. The request still stands. |
| 409 | `booking_off` | `slotStart` sent while the company has online booking off. Send `callMe` instead. |
| 413 | `too_large` | A photo over 12 MB, or a JSON body over 256 KB. |
| 415 | `unsupported_media` | A photo that is not a JPEG or PNG (a HEIC gets the "set the camera to Most Compatible" sentence). |
| 422 | `address_not_found` | The address could not be found (`field: "address"`). |
| 422 | `service_not_offered` | A `services` value this company does not offer (`field: "services"`). |
| 422 | `window_unsizable` | The window cannot be sized from what was sent (degenerate corners, a card that is not credit-card sized, an AR size outside 6 to 200 in). `error` says what to redo in plain words. |
| 429 | `rate_limited` | Too many calls. The `Retry-After` header says how many seconds to wait. The app retries once after that, then shows `error`. |
| 503 | `storage_unavailable` | Photo storage is down. Retry later. |

## Limits

- Per IP: 240 calls a minute in all; 10 new requests (`POST /requests`) an hour; 60 `.../slots` an hour.
- Per token (per request): 120 calls a minute; 90 photos; 60 windows; 5 `.../contact` an hour; 20 `.../book` an hour.
- Wrong tokens: 30 an hour per IP, then every call from that IP is a 429 for the rest of the hour.
- Per company: the instant quote page's daily cap of measured addresses is shared with this API. When it is reached,
  `POST /requests` answers `status: "callback"`, `callbackReason: "busy"`.

## The journey, in calls

1. `GET /company` -> brand, services, booking, consent words, window styles.
2. `POST /requests` -> `requestId` + `token`, the home, the estimates.
3. Windows: `POST .../uploads` (a photo), `POST .../windows` (a measured window), repeat. `GET .../requests/:id` any time.
4. `PATCH .../requests/:id` if the homeowner says how many windows they have.
5. `POST .../contact` -> the lead exists on the company's side (the consent is stored here).
6. `GET .../slots`, then `POST .../book` with `slotStart` or `callMe`.
7. `GET .../status` for the progress screen.

## GET /company

Public, no token. The words in `consent` are shown **verbatim** next to the two boxes of the contact screen, and
`consent.version` is sent back in `POST .../contact`. The button that sends the contact form must be labeled exactly
**Send my request**, because the consent sentence names it.

```json
{
  "apiVersion": 1,
  "name": "Summit Ridge Roofing",
  "brandColor": "#155EAB",
  "phone": "+19495550123",
  "services": ["windows", "roof", "gutters"],
  "booking": true,
  "privacyUrl": "https://app.example.com/c/summit-ridge/privacy",
  "termsUrl": "https://app.example.com/c/summit-ridge/terms",
  "consent": {
    "version": "2026-10-16",
    "text": "By checking this box and clicking \"Send my request\", I agree that Summit Ridge Roofing may contact me ...",
    "textingText": "Text me too: Summit Ridge Roofing may send text messages about my estimate ..."
  },
  "windowStyles": [{ "key": "double-hung", "label": "Double-hung" }, { "key": "single-hung", "label": "Single-hung" }],
  "trust": null,
  "limits": { "maxWindows": 60, "maxPhotoBytes": 12582912, "maxRoomLength": 40, "maxLabelLength": 80, "tokenDays": 60 }
}
```

- `services`: what the company offers, in the order to list them. The app shows only these.
- `booking`: false means there are no online visit times: offer only "Call me".
- `trust`: always `null` for now (later: `{ reviews?, since?, license? }`).
- `windowStyles`: the nine style keys with plain labels (`double-hung`, `single-hung`, `slider-2`, `slider-3`, `picture`,
  `casement`, `awning`, `arch`, `circle`).

## POST /requests

Body: `{ "address": "<5 to 200 characters>", "services": ["windows", "roof"] }` (1 to 3 of the company's services, no
repeats). The first call for a new address looks it up and measures it from above (a few seconds); an address measured
in the last 30 days answers at once.

`201`:

```json
{
  "requestId": "0b6a3b0e-0000-4000-8000-000000000001",
  "token": "kQ3x...43 characters...",
  "expiresAt": "2026-12-15T20:00:00.000Z",
  "status": "ready",
  "home": {
    "address": "123 Main St, Irvine, CA 92620",
    "floors": 2,
    "outline": { "center": [-117.8, 33.68], "ring": [[-117.80001, 33.68001], [-117.8, 33.68002]] }
  },
  "estimate": {
    "windows": { "low": 12, "high": 16, "likely": 14 },
    "roof": { "low": 14000, "high": 18000, "squares": 28.5 },
    "gutters": null
  },
  "services": ["windows", "roof"]
}
```

- `status: "callback"` (with `callbackReason`) means: no online estimate, the company will call. `estimate` then has no
  windows and no roof. Reasons: `unit` (an apartment, suite or unit), `address` (the address could not be pinned to
  one house), `home` (a house a person has to look at: very large, flat or hard to see), `busy` (nothing could be
  measured right now: the company's daily limit, or the address lookup is down). The token is still returned: the
  contact and booking calls work. Windows calls are refused (`callback_only`).
- `home.floors`: 1, 1.5, 2 or 3, or `null` when the height is not known. `home.outline`: the main roof's corners as
  `[longitude, latitude]` to draw on the app's own map, or `null`. There is no photo of the house.
- `estimate.windows`: a count from the walls: `likely` is the number the quote uses, `low` to `high` is the plausible
  range (equal when the walls are clear). `null` when windows were not asked for or cannot be counted.
- `estimate.roof`: a price range in dollars (rounded out to hundreds) and the roof's size in squares. `null` when roof
  was not asked for or could not be priced.
- `estimate.gutters`: `"at-visit"` when gutters were asked for: they are priced at the free visit, never online.

## GET /requests/:id

Needs the token. The view of the whole request, and the answer to every change below.

```json
{
  "request": {
    "id": "0b6a3b0e-0000-4000-8000-000000000001",
    "status": "ready",
    "services": ["windows", "roof"],
    "home": { "address": "123 Main St, Irvine, CA 92620", "floors": 2, "outline": null },
    "estimate": { "windows": { "low": 12, "high": 16, "likely": 14 }, "roof": { "low": 14000, "high": 18000, "squares": 28.5 }, "gutters": null },
    "estimatedTotalOverride": null,
    "contactFiled": false,
    "createdAt": "2026-10-16T20:00:00.000Z",
    "expiresAt": "2026-12-15T20:00:00.000Z"
  },
  "windows": [
    {
      "id": "w-kitchen-1",
      "room": "Kitchen",
      "label": "Over the sink",
      "style": "double-hung",
      "scale": { "kind": "card", "cardCorners": [[100, 100], [400, 100], [400, 290], [100, 290]], "card": { "widthMm": 85.6, "heightMm": 53.98 } },
      "uploadId": "7d4e1d3a-0000-4000-8000-000000000002",
      "corners": [[300, 400], [1300, 400], [1300, 1900], [300, 1900]],
      "widthIn": 35.6,
      "heightIn": 59.6,
      "sizeClass": "standard",
      "uncertaintyIn": { "width": 0.3, "height": 0.4 },
      "quality": "good",
      "reasons": [],
      "sizeLabel": "35 5/8 x 59 5/8",
      "uncertaintyLabel": "about ±1/2 in"
    }
  ],
  "rooms": ["Kitchen"],
  "quote": {
    "tiers": [
      {
        "key": "good",
        "label": "Good",
        "name": "Vinyl double-hung",
        "description": "Double-pane, Low-E glass, standard install",
        "total": 8400,
        "perWindow": [{ "windowId": "w-kitchen-1", "price": 600 }],
        "estimatedCount": 13,
        "estimatedTotal": 7800
      }
    ],
    "measuredCount": 1,
    "estimatedCount": 13,
    "missingHint": { "measured": 1, "expectedLow": 12, "expectedHigh": 16, "expectedLikely": 14, "text": "We think your home has about 12 to 16 windows and you have measured 1. Did we miss any?" }
  }
}
```

- `windows` are the homeowner's own, newest last. `rooms` lists the rooms used so far, first use first (for the room
  picker's "recent" row).
- `quote` is `null` when the request is not about windows or is `callback`. Otherwise `tiers` has **Good, Better and Best**
  (the company's enabled tiers). For each tier `total = sum(perWindow.price) + estimatedTotal`. **Measured** windows
  are priced at their own size class; the windows not measured yet (`estimatedCount`) are priced from the address
  estimate (or from `estimatedTotalOverride`) and stay "estimated" in the app. `estimatedCount` is
  `max(0, expected windows - measured windows)`. With nothing measured the quote is all estimated.
- `missingHint`: present when the homeowner measured fewer windows than the low end of the address estimate (never
  when they set `estimatedTotalOverride`). Show `text` as "Did we miss any?".
- `booking` (once `.../book` was called): `{ "visit": { "start", "end", "timeZone" } | null, "callMe": boolean }`.
- `status` (once `.../contact` was called): the same body as `GET .../status`.
- A window is **`quality: "check"`** when it is not a good measure (`reasons` says why in plain words, `uncertaintyLabel`
  says how far off it may be). A `check` window still counts in the quote; the free visit re-measures every window.
- `sizeLabel` is width x height to the nearest 1/8 inch. `uncertaintyLabel` is the larger of the two uncertainties,
  rounded **up** to the next 1/8 inch ("about ±1/8 in"); never show a bare "±".
- Rounding: AR sizes are kept to 1/100 inch, the others to 1/10 inch.

## POST /requests/:id/uploads

One photo for a window. Send the file's bytes with `Content-Type: image/jpeg` (or `image/png`), or a
`multipart/form-data` body with the file in the field `photo`. At most 12 MB. The bytes are checked, not the declared
type. A HEIC is refused (set the camera to JPEG: Settings > Camera > Formats > Most Compatible). Keep the photo's EXIF
orientation as the camera wrote it; every pixel coordinate you send later is in the photo **as displayed** (EXIF
orientation applied).

`201`: `{ "id": "7d4e1d3a-0000-4000-8000-000000000002", "widthPx": 3024, "heightPx": 4032 }` (displayed size). Upload
first, then send the window with this `uploadId`. A retried upload makes a second photo: send the window with the
newer `id`.

## POST /requests/:id/windows

Body `HomeownerWindowInput`:

```json
{
  "id": "w-kitchen-1",
  "room": "Kitchen",
  "label": "Over the sink",
  "style": "double-hung",
  "scale": { "kind": "card", "cardCorners": [[100, 100], [400, 100], [400, 290], [100, 290]], "card": { "widthMm": 85.6, "heightMm": 53.98 } },
  "uploadId": "7d4e1d3a-0000-4000-8000-000000000002",
  "corners": [[300, 400], [1300, 400], [1300, 1900], [300, 1900]]
}
```

- `id`: made by the app (1 to 64 of letters, digits, `_`, `-`; a UUID is fine). **Idempotent**: sending the same window
  again (a retry after a lost answer) answers **200** with the view and changes nothing; a **different** window with
  the same id is `409 window_id_taken`. A new window is **201**.
- `room`: 1 to 40 characters (the picker's name or typed). `label`: optional, up to 80. `style`: one of the company's
  `windowStyles` keys.
- `scale` (one of):
  - `{ "kind": "ar", "pointsM": [[x,y,z] x4], "trackingLostCount": 0, "device": "arkit" | "arkit-lidar", "cornerSpreadM"?: [n,n,n,n] }`
    the four frame corners in AR space, metres (any order: the server orders them by gravity). `uploadId` + `corners`
    (the same four corners as pixels in the photo) are required.
  - `{ "kind": "roomplan", "widthM": 0.9, "heightM": 1.5, "confidence": "low" | "medium" | "high" }` straight from a room
    scan. Quote-grade: always `check`, never less than 1 inch of uncertainty. `uploadId` and `corners` are optional (a
    room-scan window may have no photo).
  - `{ "kind": "card", "cardCorners": [[x,y] x4], "card": { "widthMm": 85.6, "heightMm": 53.98 } }` a credit card (any
    ID-1 card: credit, debit, driver licence) lying flat on the glass. `cardCorners` are the card's four corners as
    tapped on the photo (tap the tip of each rounded corner), in order around the card, starting at any corner,
    clockwise or not. `uploadId` + `corners` (the window frame's four corners, top-left, top-right, bottom-right,
    bottom-left, in an upright photo) are required. `card` must be exactly 85.6 x 53.98. Quote-grade: its uncertainty
    grows with the window's size next to the card, and it is `check` above 3/8 inch (see `docs/windows/card-method.md`).
- All pixel coordinates are in the photo as displayed, inside `0..widthPx` and `0..heightPx` of that upload.
- The answer is the same view as `GET /requests/:id` (so the app has the new quote and the window's size at once).
- `422 window_unsizable`: the window cannot be sized (the `error` sentence says what to redo). Nothing is saved.
- Homeowner windows are **quote-grade only**: the company re-measures at the free visit before any factory order.

## DELETE /requests/:id/windows/:windowId

`200` with the view without the window. A window that is not there is also `200` (a retried delete is harmless).

## PATCH /requests/:id

Body `{ "estimatedTotalOverride": 18 }`: the homeowner says "I have 18 windows" (1 to 80 in all, measured ones included).
`null` takes it back to the address estimate. `200` with the view. This changes `quote.estimatedCount` and drops
`missingHint`.

## POST /requests/:id/contact

Files the request with the company: a customer, the address and a Lead job (source "Homeowner app") with the quote on
its timeline, an alert for the office and the consent as evidence. After this the company can call.

```json
{
  "firstName": "Alex",
  "lastName": "Rivera",
  "phone": "(949) 555-0147",
  "email": "alex@example.com",
  "zip": "92620",
  "contactConsent": true,
  "textConsent": false,
  "consentVersion": "2026-10-16"
}
```

- `contactConsent` must be `true` (the required box: calls and email). `textConsent`: the optional "text me too" box,
  unticked to start. The server stores the version and the exact words of each box that was ticked, the time and a hash
  of the IP address. Texting consent stays "none" on the customer (the box is evidence only).
- `phone` is any US number; stored as E.164. `zip`: 5 digits (or ZIP+4).
- `201` the first time, `200` for the same phone again; both with the view (`request.contactFiled: true`, `status`).

## GET /requests/:id/slots

`{ "timeZone": "America/Los_Angeles", "slots": [{ "id": "2026-10-17T16:00:00.000Z", "start": "2026-10-17T16:00:00.000Z", "end": "2026-10-17T17:00:00.000Z" }] }`.
The next open in-home visit times, from tomorrow, at most two a day, up to 8. Empty when the company has booking off
or nothing is open: offer "Call me".

## POST /requests/:id/book

Needs `.../contact` first. Body is **one** of `{ "slotStart": "<a slot's start>" }` or `{ "callMe": true }`.

- `slotStart`: books the free in-home visit. The job moves to Inspection with the visit on the calendar, the office's
  "call the homeowner" reminder is cleared. `200` with the view and `booking.visit`.
- `callMe`: the homeowner asks to be called to set up the visit. The job keeps its "call the homeowner" reminder.
  `200` with `booking: { "visit": null, "callMe": true }`.
- Booking again after a visit is booked answers `200` with the visit already booked.
- Either way the job's timeline gets a line with the homeowner's windows and the quote they saw.

## GET /requests/:id/status

```json
{
  "stage": "visit-booked",
  "dates": { "requestedAt": "2026-10-16T20:05:00.000Z", "visit": "2026-10-17T16:00:00.000Z", "measuredAt": null, "orderedAt": null, "installedAt": null },
  "rep": { "name": "Sam" },
  "timeZone": "America/Los_Angeles"
}
```

`stage`: `requested` (asked, nothing booked), `visit-booked`, `measured` (the company measured the windows), `ordered`
(the factory order is ready or sent), `built`, `shipped`, `installed`. `built` and `shipped` are reserved: the server does
not send them yet. `rep.name` is a first name and appears once a rep is on the visit.

## Trying it on this machine

(Walkthrough with real output: filled in at the end of this page.)

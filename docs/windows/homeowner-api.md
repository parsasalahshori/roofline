# Homeowner API (the WinChoice phone app)

The contract between the homeowner's phone app and the server. Everything the app needs, signed out: no staff session, no
cookies. Types for every body are in `packages/shared/src/homeowner.ts` (`Homeowner*`); the code is
`apps/api/src/public/homeowner*.ts`; the tests are `apps/api/test/homeowner.test.ts`. **Status: final for the iPhone app
(`apiVersion: 1`). Every example below is real output from `npm run demo` (see "Trying it on this machine").**

- Base: `/api/public/homeowner/:slug`. The slug is the company's instant-quote slug (demo company: `summit-ridge`). A slug
  that does not exist, or whose page is turned off, is a 404 on `GET /company` and `POST /requests`. A request made before
  the page was turned off can still be looked at, measured and shown its status; the contact form, the visit times and
  booking answer 404 `not_found`.
- JSON in and out (`Content-Type: application/json`), except the photo upload. Every answer carries
  `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- Money is whole US dollars (integers). Sizes are inches. Times are ISO 8601 with a `Z`.
- Auth: `POST /requests` returns a **token**; every `/requests/:id/...` call sends `Authorization: Bearer <token>`. The
  token is 32 random bytes in base64url (43 characters). The server keeps only its SHA-256 hash, so a lost token cannot be
  recovered: start a new request. A token lasts **60 days** from the request. Keep `requestId` + `token` in the Keychain.
- Nothing personal goes in a URL or a log. The only personal details are in the one `POST .../contact` body.
- No cookies, no CORS needs: a native app sends no `Origin` header and is never blocked by the cross-site check.

## What the app has to do (short list)

- Show the company's `consent.text` and `consent.textingText` **verbatim** next to the two boxes, send `consent.version`
  back, and label the button that sends the contact form exactly **Send my request** (the consent sentence names it).
- Send every pixel coordinate in the photo **as displayed** (EXIF orientation applied), inside the uploaded size.
- Treat `quality: "check"` as a normal answer, not an error: it means "quote-grade, we measure again at the free visit".
  With the credit-card method **most real windows come back `check`** (see "Card photo").
- Retry a window with the same `id` after a lost answer (idempotent); do not retry an upload blindly (see below).
- Switch on `code`, show `error` (a sentence written for the homeowner). On 429, wait `Retry-After` seconds, retry once.

## Errors

Every error body is `{ "error": "<a sentence to show a person>", "field"?: "<body field>", "code": "<machine code>" }`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | A field is missing or wrong (`field` names it). Includes a corner outside the photo, an `uploadId` that is not one of this request's photos, a bad `slotStart`, an unreadable JSON body. |
| 401 | `unauthorized` | No token, a malformed token, a wrong token, an unknown request id, or another company's request. **All look the same**, so request ids cannot be probed. |
| 401 | `token_expired` | The token is right but is past its 60 days. Start a new request. |
| 403 | `cross_site` | A browser sent an `Origin` that is not allowed. A native app sends none. |
| 404 | `not_found` | Unknown slug (or page turned off) on `GET /company` and `POST /requests`; the contact form, slots or booking on a turned-off page; a malformed window id on `DELETE`. |
| 409 | `window_id_taken` | `POST .../windows` with an id already used for a **different** window. |
| 409 | `windows_full` | The request already has 60 windows. |
| 409 | `uploads_full` | The request already has 90 photos or 250 MB of photos. |
| 409 | `callback_only` | A windows call (upload, window, count) on a request that went to the call-back path (`status: "callback"`). |
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
| 422 | `window_unsizable` | The window cannot be sized from what was sent (degenerate corners, a card that is not credit-card sized, an AR size outside 6 to 200 in). `error` says what to redo in plain words. Nothing is saved. |
| 429 | `rate_limited` | Too many calls. The `Retry-After` header says how many seconds to wait. |
| 503 | `storage_unavailable` | Photo storage is down. Retry later. |
| 503 | `unavailable` | The estimate could not be read back right now (rare). Retry. |

## Limits

- Per IP address: 240 calls a minute in all; 10 new requests (`POST /requests`) an hour; 60 `.../slots` an hour.
- Wrong tokens: 30 an hour per IP address; past that every call from that address is a 429 for the rest of the hour, even
  with a right token.
- Per request (token): 120 calls a minute; 60 photo uploads an hour; 120 window saves or deletes an hour; 5
  `.../contact` an hour (counted once the form is valid, so a mistyped phone does not use one up); 20 `.../book` an hour;
  30 `.../slots` an hour.
- What one request holds: 60 windows; 90 photos and 250 MB of photos; one photo up to 12 MB.
- Per company: the instant quote page's daily cap of measured addresses is shared with this API. When it is reached,
  `POST /requests` answers `status: "callback"`, `callbackReason: "busy"`. An address measured in the last 30 days costs
  nothing and is answered at once.

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
`consent.version` is sent back in `POST .../contact`.

```json
{
  "apiVersion": 1,
  "name": "Summit Ridge Roofing",
  "brandColor": null,
  "phone": "+14025550180",
  "services": ["windows", "roof", "gutters"],
  "booking": true,
  "privacyUrl": "https://summit-ridge-roofing.roofline.test/privacy",
  "termsUrl": "https://summit-ridge-roofing.roofline.test/terms",
  "consent": {
    "version": "2026-10-16",
    "text": "By checking this box and clicking \"Send my request\", I agree that Summit Ridge Roofing may contact me about my estimate and appointment by phone call and email at the phone number and email I provided, including calls that may use automated technology or a prerecorded or artificial voice. Consent is not a condition of purchase. I agree to the Privacy Policy and Terms.",
    "textingText": "Text me too: Summit Ridge Roofing may send text messages about my estimate and appointment to the phone number I provided, which may be sent using automated technology. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to stop texts or HELP for help."
  },
  "windowStyles": [
    { "key": "double-hung", "label": "Double-hung" },
    { "key": "single-hung", "label": "Single-hung" },
    { "key": "slider-2", "label": "Slider, 2 panes" },
    { "key": "slider-3", "label": "Slider, 3 panes" },
    { "key": "picture", "label": "Picture (does not open)" },
    { "key": "casement", "label": "Casement (cranks open)" },
    { "key": "awning", "label": "Awning (tilts out)" },
    { "key": "arch", "label": "Arch top" },
    { "key": "circle", "label": "Round" }
  ],
  "trust": null,
  "limits": { "maxWindows": 60, "maxPhotoBytes": 12582912, "maxRoomLength": 40, "maxLabelLength": 80, "tokenDays": 60 }
}
```

- `services`: what the company offers, in the order to list them. The app shows only these.
- `brandColor`: `#rrggbb` or `null` (use the app's own colour).
- `booking`: false means there are no online visit times: offer only "Call me".
- `trust`: always `null` for now (later: `{ reviews?, since?, license? }`).
- `windowStyles`: the nine style keys with plain labels.
- The consent text names the company and is the exact sentence the server stores when the box is ticked. The version is
  the date the wording last changed; a stale one is refused with `409 consent_changed`.

## POST /requests

Body: `{ "address": "<5 to 200 characters>", "services": ["windows", "roof"] }` (1 to 3 of the company's services, no
repeats). The first call for a new address looks it up and measures it from above (a few seconds); an address measured
in the last 30 days answers at once.

`201`:

```json
{
  "requestId": "d1a18ca3-63ed-447f-b53a-e1f6276ccf71",
  "token": "Sb_kMSOnM2pD4CE7bykxE1EYltxTzm6CzaX9UZAnVmQ",
  "expiresAt": "2026-12-15T21:22:11.011Z",
  "status": "ready",
  "home": {
    "address": "4810 Underwood Ave, Omaha, NE 68132",
    "floors": null,
    "outline": {
      "ring": [[-96.124698, 41.301514], [-96.124697, 41.301537], [-96.12463, 41.301536], [-96.124625, 41.301669], [-96.124783, 41.301672], [-96.124789, 41.301516]],
      "center": [-96.124708, 41.3015969]
    }
  },
  "estimate": {
    "windows": { "low": 14, "high": 28, "likely": 14 },
    "roof": { "low": 12900, "high": 16500, "squares": 26.5 },
    "gutters": "at-visit"
  },
  "services": ["windows", "roof", "gutters"]
}
```

- `status: "callback"` (with `callbackReason`) means: no online estimate, the company will call. `estimate` then has no
  windows and no roof. Reasons: `unit` (an apartment, suite or unit), `address` (the address could not be pinned to
  one house), `home` (a house a person has to look at: very large, flat or hard to see), `busy` (nothing could be
  measured right now: the company's daily limit, or the address lookup is down). The token is still returned: the
  contact and booking calls work. Windows calls are refused (`callback_only`). Example:
  `{"status":"callback","callbackReason":"unit","home":{"address":"2200 Riverfront Dr Apt 1203, Omaha, NE 68102","floors":null,"outline":null},"estimate":{"windows":null,"roof":null,"gutters":null},"services":["windows","roof"]}`
- `home.floors`: 1, 1.5, 2 or 3, or `null` when the height is not known. `home.outline`: the main roof's corners as
  `[longitude, latitude]` (`ring`, closed or not) and its `center`, to draw on the app's own map, or `null`. There is no
  photo of the house.
- `estimate.windows`: a count from the walls: `likely` is the number the quote uses, `low` to `high` is the plausible
  range (equal when the walls are clear; wide when the number of floors is not known, as above). `null` when windows were
  not asked for or cannot be counted.
- `estimate.roof`: a price range in dollars (rounded out to hundreds) and the roof's size in squares. `null` when roof
  was not asked for or could not be priced.
- `estimate.gutters`: `"at-visit"` when gutters were asked for: they are priced at the free visit, never online. A
  gutters-only request is only looked up and checked (the same gates), it never uses a measurement.

## GET /requests/:id

Needs the token. The view of the whole request, and the answer to every change below.

```json
{
  "request": {
    "id": "d1a18ca3-63ed-447f-b53a-e1f6276ccf71",
    "status": "ready",
    "services": ["windows", "roof", "gutters"],
    "home": { "address": "4810 Underwood Ave, Omaha, NE 68132", "floors": null, "outline": { "ring": ["..."], "center": [-96.124708, 41.3015969] } },
    "estimate": { "windows": { "low": 14, "high": 28, "likely": 14 }, "roof": { "low": 12900, "high": 16500, "squares": 26.5 }, "gutters": "at-visit" },
    "estimatedTotalOverride": null,
    "contactFiled": true,
    "createdAt": "2026-10-16T21:22:11.011Z",
    "expiresAt": "2026-12-15T21:22:11.011Z"
  },
  "windows": [
    {
      "id": "w-kitchen-1",
      "room": "Kitchen",
      "label": "Over the sink",
      "style": "double-hung",
      "scale": { "kind": "card", "cardCorners": [[1437, 1968], [1587, 1969], [1587, 2063], [1437, 2064]], "card": { "widthMm": 85.6, "heightMm": 53.98 } },
      "uploadId": "33d44c23-1e91-42a6-bdb4-16c53aec0380",
      "corners": [[644, 532], [2312, 675], [2312, 3357], [644, 3500]],
      "widthIn": 36,
      "heightIn": 60,
      "sizeClass": "standard",
      "uncertaintyIn": { "width": 0.55, "height": 0.91 },
      "quality": "check",
      "reasons": ["The card is small next to this window, so the size could be off by about 1 inch. Hold the card flat in the middle of the glass and step a little closer."],
      "sizeLabel": "36 x 60",
      "uncertaintyLabel": "about ±1 in"
    }
  ],
  "rooms": ["Kitchen", "Bedroom", "Living room"],
  "quote": {
    "tiers": [
      {
        "key": "good",
        "label": "Good",
        "name": "Vinyl double-hung",
        "description": "Double-pane, Low-E glass, standard install",
        "total": 8750,
        "perWindow": [{ "windowId": "w-kitchen-1", "price": 600 }, { "windowId": "w-bedroom-1", "price": 600 }, { "windowId": "w-living-1", "price": 750 }],
        "estimatedCount": 11,
        "estimatedTotal": 6800
      }
    ],
    "measuredCount": 3,
    "estimatedCount": 11,
    "missingHint": { "measured": 3, "expectedLow": 14, "expectedHigh": 28, "expectedLikely": 14, "text": "We think your home has about 14 to 28 windows and you have measured 3. Did we miss any?" }
  },
  "booking": { "visit": { "start": "2026-10-17T13:00:00.000Z", "end": "2026-10-17T14:00:00.000Z", "timeZone": "America/Chicago" }, "callMe": false },
  "status": {
    "stage": "visit-booked",
    "dates": { "requestedAt": "2026-10-16T21:22:11.011Z", "visit": "2026-10-17T13:00:00.000Z", "measuredAt": null, "orderedAt": null, "installedAt": null },
    "rep": { "name": "Casey" },
    "timeZone": "America/Chicago"
  }
}
```

(`quote.tiers` is cut to Good here; a real answer has Good, Better and Best.)

- `windows` are the homeowner's own, newest last. `rooms` lists the rooms used so far, first use first (for the room
  picker's "recent" row). Each window is sent back as it was saved plus the server's sizing.
- `quote` is `null` when the request is not about windows or is `callback`. Otherwise `tiers` has **Good, Better and Best**
  (the company's enabled tiers). For each tier `total = sum(perWindow.price) + estimatedTotal`. **Measured** windows
  are priced at their own size class (small up to 72 united inches, standard to 101, large to 120, picture above); the
  windows not measured yet (`estimatedCount`) are priced from the address estimate (or from `estimatedTotalOverride`)
  and stay "estimated" in the app. `estimatedCount` is `max(0, expected windows - measured windows)`, where expected is
  `estimatedTotalOverride`, else `estimate.windows.likely`, else the number measured. With nothing measured the quote is
  all estimated.
- `missingHint`: present when the homeowner measured fewer windows than the low end of the address estimate (never
  when they set `estimatedTotalOverride`). Show `text` as "Did we miss any?".
- `booking`: absent until `.../book` was called. `{ "visit": { start, end, timeZone } | null, "callMe": boolean }`.
- `status`: absent until `.../contact` was called; then the same body as `GET .../status`.
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

`201`: `{ "id": "33d44c23-1e91-42a6-bdb4-16c53aec0380", "widthPx": 3024, "heightPx": 4032 }` (displayed size). Upload
first, then send the window with this `uploadId`. An upload is **not** idempotent: a retried upload makes a second photo
(harmless, but it counts toward the 90): keep the first `id` you were given and send the window with it, and retry only
when you never got an answer. One photo may carry several windows (send each window with the same `uploadId`).

## POST /requests/:id/windows

Body `HomeownerWindowInput`:

```json
{
  "id": "w-kitchen-1",
  "room": "Kitchen",
  "label": "Over the sink",
  "style": "double-hung",
  "scale": { "kind": "card", "cardCorners": [[1437, 1968], [1587, 1969], [1587, 2063], [1437, 2064]], "card": { "widthMm": 85.6, "heightMm": 53.98 } },
  "uploadId": "33d44c23-1e91-42a6-bdb4-16c53aec0380",
  "corners": [[644, 532], [2312, 675], [2312, 3357], [644, 3500]]
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
    clockwise or not. `uploadId` + `corners` (the window frame's four corners: top-left, top-right, bottom-right,
    bottom-left, in an upright photo) are required. `card` must be 85.6 x 53.98 mm (either way round, 0.05 mm of slack).
    Quote-grade: its uncertainty grows with the window's size next to the card, and it is `check` above 3/8 inch
    (see "Card photo" and `docs/windows/card-method.md`).
- All pixel coordinates are in the photo as displayed, inside `0..widthPx` and `0..heightPx` of that upload.
- The answer is the same view as `GET /requests/:id` (so the app has the new quote and the window's size at once).
- `422 window_unsizable`: the window cannot be sized (the `error` sentence says what to redo). Nothing is saved.
- Homeowner windows are **quote-grade only**: the company re-measures at the free visit before any factory order.

Real answers for the three kinds, from the demo (a 36 x 60 window by card, a 30 x 48 window by AR, a 1.8 x 1.2 m room scan):

```
w-kitchen-1  card      36 x 60      about ±1 in      check   standard  "The card is small next to this window, so the size could be off by about 1 inch. ..."
w-bedroom-1  ar        30 x 48      about ±1/2 in    good    standard
w-living-1   roomplan  70 7/8 x 47 1/4  about ±1 1/2 in  check  large   "A room scan gives a rough size. We measure again at your free visit."
```

## DELETE /requests/:id/windows/:windowId

`200` with the view without the window. A window that is not there is also `200` (a retried delete is harmless). Only the
homeowner's own windows can be removed this way.

## PATCH /requests/:id

Body `{ "estimatedTotalOverride": 18 }`: the homeowner says "I have 18 windows" (1 to 80 in all, measured ones included).
`null` takes it back to the address estimate. `200` with the view. This changes `quote.estimatedCount` and drops
`missingHint`. (With 3 windows measured and 18 in all, the demo's quote has `estimatedCount: 15`, `missingHint` absent.)
Refused with `409 callback_only` / `windows_not_requested` where there is no windows quote.

## POST /requests/:id/contact

Files the request with the company: a customer, the address and a Lead job (source "Homeowner app") with the quote on
its timeline, an alert for the office, a "call the homeowner" reminder on the owner's Today, and the consent as evidence.
After this the company can call.

```json
{
  "firstName": "Alex",
  "lastName": "Rivera",
  "phone": "(402) 555-0147",
  "email": "alex@example.com",
  "zip": "68132",
  "contactConsent": true,
  "textConsent": false,
  "consentVersion": "2026-10-16"
}
```

- `contactConsent` must be `true` (the required box: calls and email). `textConsent`: the optional "text me too" box,
  unticked to start (may be left out). `consentVersion` is **required** and must be the current `consent.version`. The
  server stores the version and the exact words of each box that was ticked, the time and a hash of the IP address.
  Texting consent stays "none" on the customer (the box is evidence only; the company confirms texting itself).
- `phone` is any US number; stored as E.164. `zip`: 5 digits (or ZIP+4). `email`: a valid address.
- `201` the first time, `200` for the same phone again (nothing new is made); both with the view
  (`request.contactFiled: true`, `status`). Another phone number for the same request is `409 contact_filed`.
- Sending the same person's details for the same house within a day from a second request reuses their lead: no second job.

## GET /requests/:id/slots

`{ "timeZone": "America/Chicago", "slots": [{ "id": "2026-10-17T13:00:00.000Z", "start": "2026-10-17T13:00:00.000Z", "end": "2026-10-17T14:00:00.000Z" }, ...] }`.
The next open in-home visit times, from tomorrow, at most two a day, up to 8 (the demo answers 8, over the next few working
days). Empty (`"timeZone": "UTC"`) when the company has booking off or nothing is open: offer "Call me". Show the times in
`timeZone`, not the phone's own. No inspector is named before a visit is booked.

## POST /requests/:id/book

Needs `.../contact` first. Body is **one** of `{ "slotStart": "<a slot's start>" }` or `{ "callMe": true }`.

- `slotStart`: books the free in-home visit. The job moves to Inspection with the visit on the calendar, the office's
  "call the homeowner" reminder is cleared. `200` with the view and `booking.visit` (and `status.rep.name`, the
  inspector's first name).
- `callMe`: the homeowner asks to be called to set up the visit. The job keeps its "call the homeowner" reminder.
  `200` with `booking: { "visit": null, "callMe": true }`.
- Booking again after a visit is booked answers `200` with the visit already booked (a second time is not booked).
- Either way the job's timeline gets a line with the homeowner's windows and the quote they saw.

## GET /requests/:id/status

```json
{
  "stage": "visit-booked",
  "dates": { "requestedAt": "2026-10-16T21:22:11.011Z", "visit": "2026-10-17T13:00:00.000Z", "measuredAt": null, "orderedAt": null, "installedAt": null },
  "rep": { "name": "Casey" },
  "timeZone": "America/Chicago"
}
```

`stage`: `requested` (asked, nothing booked), `visit-booked`, `measured` (the company measured the windows), `ordered`
(the factory order is ready or sent), `built`, `shipped`, `installed`. `built` and `shipped` are reserved: the server does
not send them yet. `rep.name` is a first name and appears once a rep is on the visit. `status` is also valid before
`.../contact` (it is then `requested`).

## Card photo (what the app should coach)

The credit-card method sizes a window from one photo: a credit, debit or driver licence card (all 85.6 x 53.98 mm) lying
flat **on the glass**, eight taps. It is quote-grade: on synthetic photos the uncertainty is about 1.5% of the window's
longest side, so **every window from 24 x 36 inches up comes back `check`** and a 36 x 60 window is about "±1 in". The
full study and the table of errors by window size, distance and angle are in `docs/windows/card-method.md`. Show the
`check` answer plainly ("about ±1 in, we confirm at your free visit") and keep going; do not make it look like a failure.

Coaching text for the card screen:

- Use a real card from a wallet: credit, debit or driver licence. A gift card or business card is not the right size.
- Tape the card flat ON the glass, in the middle of the window, fully visible, no glare. Held out in front of the glass it
  makes the window look about 1.7% too small for every inch.
- Stand square to the window, 3 to 5 feet back, the whole window in the photo with some room around it. Use the main (1x)
  camera, not the wide one. Hold still.
- Tap the TIP of each rounded corner of the card, using the magnifier, then the four inside corners of the frame: top
  left, then clockwise. (Tapping where the sharp corners would be makes the window about 2.6% too small.)

## What the company sees

- A **customer** and the **address** (the one found, or as typed when the lookup was down), a **Lead job** with source
  "Homeowner app" and a timeline line like: "Homeowner app request. Asked about windows, roof, gutters. Shown: Roof about 26.5
  squares, $12,900 to $16,500; 3 windows measured in the app (2 to check): Good $8,750, Better $11,650, Best $17,450 for 14
  windows (11 estimated). Gutters are priced at the visit."
- The owner's **Today** list shows "Call the homeowner about their app request" until a visit is booked.
- Booking a time adds the inspection to the calendar and a line on the timeline; "call me" adds a line and keeps the reminder.
- The **consent** is on the quote request (the words, the version, the time, an IP hash); the customer's texting consent
  stays "none".
- **Measure windows** on that address (a rep's new measurement, in the web app or the iPhone staff app) starts with the
  homeowner's windows: named by room, tagged "Homeowner app", marked `source: "homeowner-app"`, with their photos. They
  are quote-grade: on a factory order they are quote-only lines until the rep measures them again. Windows from a
  request the homeowner never sent in (no contact form) are not copied; the homeowner's own copy is never the address's
  "newest measurement" for staff (it has no walls or street photos and would hide the company's own earlier one).

## The instant quote page and the app

`/q/:slug` (the company's web page) starts with "What are you looking for?" (roof, windows, gutters) and, for windows,
offers "Measure with the WinChoice app" (a store button, and a QR code on a computer) or "Have us measure at a free
visit". The offer appears only when the server has `HOMEOWNER_APP_URL` (the App Store or TestFlight link); the name is
`HOMEOWNER_APP_NAME` (default `WinChoice`). The page's config (`GET /api/public/quote/:slug`) carries
`homeownerApp: { url, name } | null`.

## Trying it on this machine

```sh
npm run demo        # app on http://localhost:4500, database on 54339 (DEMO_PORT, DEMO_DB_PORT, DEMO_COMPOSE_PROJECT change them)
```

- The demo company is **Summit Ridge Roofing**, slug `summit-ridge`: windows, roof and gutters on, online booking on.
  The API is `http://localhost:4500/api/public/homeowner/summit-ridge`; the web page is `http://localhost:4500/q/summit-ridge`.
- With no keys, the demo's address lookup puts any typed address on one of its real Omaha houses: the outline, roof size
  and window count come from that house. With `.env.keys` it uses real lookups (a few cents per new address; repeats within
  30 days are free).
- `HOMEOWNER_APP_URL` is a placeholder App Store link in the demo, so the page shows the app offer.
- The demo listens on `127.0.0.1` only. The iOS Simulator reaches it at `http://localhost:4500`; a real iPhone needs a tunnel.
- Sign in at `http://localhost:4500` as `owner@summitridge.test` / `summit-ridge-demo` to see the lead (Jobs, Today, the
  job's timeline) and, in Measure windows, the homeowner's windows.

The same walk with `curl` (needs `jq`). `B` is the base; the commands are the ones that produced the output above.

```sh
B=http://localhost:4500/api/public/homeowner/summit-ridge

# 1. The company (the consent words and version)
curl -s $B/company | jq '{name, services, booking, consent: {version: .consent.version}}'

# 2. A request: the home, the estimates, the token (shown once)
curl -s -X POST $B/requests -H 'Content-Type: application/json' \
  -d '{"address":"4810 Underwood Ave, Omaha, NE 68132","services":["windows","roof","gutters"]}' > req.json
REQ=$(jq -r .requestId req.json); TOKEN=$(jq -r .token req.json)
jq '{status, estimate}' req.json

# 3. A photo (any JPEG: a phone photo keeps its EXIF; every pixel below is in the photo as displayed)
UP=$(curl -s -X POST $B/requests/$REQ/uploads -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/jpeg' --data-binary @photo.jpg | jq -r .id)

# 4. A window: card on the glass, four taps on the card and four on the frame (here a 3024 x 4032 photo)
curl -s -X POST $B/requests/$REQ/windows -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "id":"w-kitchen-1","room":"Kitchen","label":"Over the sink","style":"double-hung",
  "scale":{"kind":"card","cardCorners":[[1437,1968],[1587,1969],[1587,2063],[1437,2064]],"card":{"widthMm":85.6,"heightMm":53.98}},
  "uploadId":"'$UP'","corners":[[644,532],[2312,675],[2312,3357],[644,3500]]}' \
  | jq '.windows[0] | {id, sizeLabel, uncertaintyLabel, quality}, .quote.tiers[0] | {total, estimatedCount}'
#   -> { "id": "w-kitchen-1", "sizeLabel": "36 x 60", "uncertaintyLabel": "about ±1 in", "quality": "check" }

# 5. A room-scan window needs no photo
curl -s -X POST $B/requests/$REQ/windows -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"w-living-1","room":"Living room","style":"picture","scale":{"kind":"roomplan","widthM":1.8,"heightM":1.2,"confidence":"medium"}}' \
  | jq '.windows[-1] | {sizeLabel, uncertaintyLabel, quality, reasons}'

# 6. "I have 18 windows"
curl -s -X PATCH $B/requests/$REQ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"estimatedTotalOverride":18}' \
  | jq '.quote | {measuredCount, estimatedCount, missingHint}'

# 7. Contact (the consent version comes from step 1; the button is "Send my request")
VER=$(curl -s $B/company | jq -r .consent.version)
curl -s -X POST $B/requests/$REQ/contact -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "firstName":"Alex","lastName":"Rivera","phone":"(402) 555-0147","email":"alex@example.com","zip":"68132",
  "contactConsent":true,"textConsent":false,"consentVersion":"'$VER'"}' | jq '{contactFiled: .request.contactFiled, status}'

# 8. Visit times, then book the first one
curl -s $B/requests/$REQ/slots -H "Authorization: Bearer $TOKEN" > slots.json
START=$(jq -r '.slots[0].start' slots.json)
curl -s -X POST $B/requests/$REQ/book -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"slotStart":"'$START'"}' | jq '{booking, status}'

# 9. Status for the progress screen
curl -s $B/requests/$REQ/status -H "Authorization: Bearer $TOKEN" | jq
```

What the errors look like (real answers):

```
no token / wrong token / unknown id   401  {"error":"We couldn't find your request. Please start a new estimate.","code":"unauthorized"}
bad body                              400  {"error":"Please enter the address of the home.","field":"address","code":"invalid_request"}
apartment (Apt 1203)                  201  {"status":"callback","callbackReason":"unit",...}   then a windows call:
                                      409  {"error":"We'll call you about this home, so there is nothing to measure here.","code":"callback_only"}
same window id, different window      409  {"error":"A different window with this id is already saved. Give the new window its own id.","field":"id","code":"window_id_taken"}
contact without the box ticked        400  {"error":"Please check the box so we can call or email you.","field":"contactConsent","code":"invalid_request"}
contact with old consent words        409  {"error":"The wording on this screen was updated. Please go back and try again.","code":"consent_changed"}
other phone for a filed request       409  {"error":"We already have your details for this request. Please call us to change them.","field":"phone","code":"contact_filed"}
windows call on a gutters request     409  {"error":"This request is not about windows.","code":"windows_not_requested"}
```

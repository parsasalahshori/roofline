# Homeowner API (the WinChoice phone app)

The contract between the homeowner's phone app and the server. Everything the app needs, signed out: no staff session, no
cookies. The shapes of the answers are `Homeowner*` in `packages/shared/src/homeowner.ts`; the request bodies are the
zod schemas at the top of `apps/api/src/public/homeowner.ts`, which is the code (with `homeowner-auth.ts`,
`homeowner-view.ts`, `homeowner-upload.ts`); the tests are `apps/api/test/homeowner.test.ts`. **Status: final for the
iPhone app (`apiVersion: 1`). The examples below are real output from `npm run demo` (see "Trying it on this machine"),
cut where they say so.**

- Base: `/api/public/homeowner/:slug`. The slug is the company's instant-quote slug (demo company: `summit-ridge`). A slug
  that does not exist, or whose page is turned off, is a 404 `not_found` on `GET /company` and `POST /requests`, and on
  every `/requests/:id/...` call too (answered before the token is looked at). A request made before the page was turned
  off can still be looked at, measured and shown its status; the contact form, the visit times and booking answer 404
  `not_found`.
- JSON in and out (`Content-Type: application/json`), except the photo upload. Every answer, a refusal included, carries
  `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- Money is whole US dollars (integers). Sizes are inches. Times are ISO 8601 with a `Z`.
- Auth: `POST /requests` returns a **token**; every `/requests/:id/...` call sends `Authorization: Bearer <token>`. The
  token is 32 random bytes in base64url (43 characters). The server keeps only its SHA-256 hash, so a lost token cannot be
  recovered: start a new request. A token lasts **60 days** from the request. Keep `requestId` + `token` in the Keychain.
  The header must be exactly `Authorization: Bearer ` and the 43 characters (anything else is a 401 like a wrong token).
- Nothing personal goes in a URL or a log. The name, phone, email and ZIP are only in the one `POST .../contact` body; the
  home address is in the `POST /requests` body (and comes back as `home.address`); photos and the room and label text are
  in the upload and window bodies. The server logs and audits ids and outcomes only.
- No cookies, no CORS needs: a native app sends no `Origin` header and is never blocked by the cross-site check.

## What the app has to do (short list)

- Show the company's `consent.text` and `consent.textingText` **verbatim** next to the two boxes, send `consent.version`
  back, and label the button that sends the contact form exactly **Send my request** (the consent sentence names it).
- Send every pixel coordinate in the photo **as displayed** (EXIF orientation applied), inside the uploaded size.
- Treat `quality: "check"` as a normal answer, not an error: it means "quote-grade, we measure again at the free visit".
  With the credit-card method **most real windows come back `check`** (see "Card photo").
- Retry a window with the same `id` after a lost answer (idempotent); do not retry an upload blindly (see below).
- Switch on `code`, show `error` (a sentence written for the homeowner). On 429, wait `Retry-After` seconds (the most you
  can be made to wait), retry once; nothing was stored by a refused call.
- Send optional fields by leaving them out, never as `null`, and no keys this document does not list: every body is strict
  (see "Details that matter when you build the client").

## Errors

Every error from a call in this document is `{ "error": "<a sentence to show a person>", "field"?: "<body field>", "code": "<machine code>" }`.
`field` is the body field the sentence is about, as a dotted path (`services.0`, `scale.card.widthMm`); it is absent when
the whole body is the problem. One answer has no `code`: an unexpected failure (`500`, `{ "error": "Something went wrong
on our side. Please try again." }`). Decode `code` as optional, and for a code you do not know, show `error`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | A field is missing or wrong (`field` names it). Includes a corner outside the photo, an `uploadId` that is not one of this request's photos, a bad `slotStart`, an unreadable JSON body. |
| 401 | `unauthorized` | No token, a malformed token, a wrong token, an unknown request id, or another company's request. **All look the same**, so request ids cannot be probed. |
| 401 | `token_expired` | The token is right but is past its 60 days. Start a new request. |
| 403 | `cross_site` | A browser sent an `Origin` that is not allowed. A native app sends none. |
| 404 | `not_found` | An unknown slug (or a page turned off) on `GET /company`, `POST /requests` and, before the token is looked at, any `/requests/:id/...` call; the contact form, slots or booking on a turned-off page; a malformed window id on `DELETE`; a path or method that is not in this document (that answer is `{ "error": "We couldn't find that.", "code": "not_found" }`). |
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
| 413 | `too_large` | A photo over 12 MiB (12,582,912 bytes, `limits.maxPhotoBytes`) that declares its size in `Content-Length` (a normal upload does; a chunked body over the limit gets the connection closed instead of this answer), or a JSON body over 256 KB. |
| 415 | `unsupported_media` | A photo that is not a JPEG or PNG (a HEIC gets the "set the camera to Most Compatible" sentence). |
| 422 | `address_not_found` | The address could not be found (`field: "address"`). |
| 422 | `service_not_offered` | A `services` value this company does not offer (`field: "services"`). |
| 422 | `window_unsizable` | The window cannot be sized from what was sent: corners that cross, are not a four-cornered shape or are degenerate; a card too small to tap (under 0.75% of the photo's long side) or bigger than half the window; a `card` that is not 85.6 x 53.98 mm; a size outside its range (AR and room scan: 6 to 200 in on either side; card: 3 to 400 in). `field` is `"scale"`; `error` says what to redo in plain words. Nothing is saved. |
| 429 | `rate_limited` | Too many calls, or too many photos being received at once. `Retry-After` (seconds) is on every one: 3 for photos, 60 for the per-minute limits, 3600 for the hourly ones. It is the most you can be made to wait, not what is left. Nothing was stored. |
| 503 | `storage_unavailable` | Photo storage is down. Retry later. |
| 503 | `unavailable` | The estimate could not be read back right now (rare). Retry. |

A rare `409 conflict` (a clash while the address was being saved: try again) and the fallbacks `403 forbidden`,
`422 unprocessable` and `error` exist for errors this document does not list; show their `error` sentence.

## Limits

- Per IP address: 240 calls a minute in all; 10 new requests (`POST /requests`) an hour, every call counting, refused ones
  too; 60 `.../slots` an hour.
- Wrong tokens: failed sign-ins count 30 an hour per IP address (no or a malformed `Authorization`, a wrong token, an
  unknown request id; an expired token does not count). Past that, every `/requests/:id/...` call from that address is a
  429 (`Retry-After: 3600`) until the hour is over, even with a right token. `GET /company` and `POST /requests` are not
  affected.
- Per request (token): 120 calls a minute; 60 photo uploads an hour; 120 window saves or deletes an hour; 5
  `.../contact` an hour (counted once the form is valid, so a mistyped phone does not use one up); 20 `.../book` an hour;
  30 `.../slots` an hour. These count calls, including calls refused for another reason (a 409 or 422, an idempotent
  replay), except where said.
- Photos being received at once: 3 per request, 6 per IP address, 12 in all on one server (a photo is held in memory
  until it is stored). A call over that is `429 rate_limited` with `Retry-After: 3` at once: nothing is read, nothing is
  stored, and the hour's count of uploads is not used. A photo that sends nothing for 20 seconds, or is not whole after
  3 minutes, is cut off (the connection closes). Upload photos one to three at a time.
- What one request holds: 60 windows; 90 photos and 250 MiB of photos; one photo up to 12 MiB (a 12-megapixel JPEG at
  normal quality is 2 to 6 MB: there is no need to send more) and 120 megapixels.
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

## Details that matter when you build the client

- **Bodies are strict.** A key this document does not list is a `400`. Leave optional fields out; `null` for `label`,
  `uploadId`, `corners`, `cornerSpreadM` or `textConsent` is a `400`. `PATCH` needs the key `estimatedTotalOverride` (`{}`
  is a `400`, "There's nothing to change"); its value may be `null`.
- **Ids.** A request id in a URL may be in any case; ids in answers are lower case, and so is an `uploadId` you send. A
  window `id` is case-sensitive, exactly as you sent it.
- **Numbers.** Pixel coordinates are within the photo (and within +-100,000); AR points within +-50 m; names 1 to 60
  characters; `phone` up to 40; `email` up to 254. A body over 256 KB is `413`.
- **What a call costs.** The limits count calls, not successes: a refused call (a `422`, a `409`, an idempotent replay)
  still uses one. Counts are per process and in memory, so they restart with the server.
- **After the contact form.** Windows, uploads and `PATCH` keep working, but the company is told once (at `.../contact`, and
  again at a booking or "call me"); later changes reach the staff only when a rep starts a measurement of the address and
  the windows are copied then.
- **Photos.** Upload one to three at a time (see "Limits"); keep the EXIF; a chunked upload has no declared size, so a
  photo over 12 MiB sent that way closes the connection instead of answering `413`.
- **Clock.** Every time is an ISO 8601 string with a `Z`; show visit times in the `timeZone` that comes with them.

## GET /company

Public, no token. The words in `consent` are shown **verbatim** next to the two boxes of the contact screen, and
`consent.version` is sent back in `POST .../contact`.

```json
{
  "apiVersion": 1,
  "name": "Summit Ridge Roofing",
  "brandColor": null,
  "phone": "+14025550180",
  "services": ["windows", "roof"],
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
- `phone`: the company's number in E.164, or `null` when it has none (then hide "Call us").
- `brandColor`: `#rrggbb` or `null` (use the app's own colour).
- `booking`: false means there are no online visit times: offer only "Call me".
- `trust`: always `null` for now (later: `{ reviews?, since?, license? }`).
- `windowStyles`: the nine style keys with plain labels.
- The consent text names the company and is the exact sentence the server stores when the box is ticked. The version is
  the date the wording last changed; a stale one is refused with `409 consent_changed`.

## POST /requests

Body: `{ "address": "<5 to 200 characters>", "services": ["windows", "roof"] }` (1 or 2 of `windows`, `roof`, no
repeats; a repeated or unknown value is a `400` with `field: "services.0"`, a known service the company does not offer is
`422 service_not_offered`: that includes `gutters`, which are measured by staff and never offered to homeowners, whatever the
company has switched on). The first call for a new address looks it up and measures it from above (a few seconds); an
address measured in the last 30 days answers at once. `services` comes back in the fixed order windows, roof,
whatever order was sent.

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
    "roof": { "low": 12900, "high": 16500, "squares": 26.5 }
  },
  "services": ["windows", "roof"]
}
```

- `status: "callback"` (with `callbackReason`) means: no online estimate, the company will call. `estimate` then has no
  windows and no roof. Reasons: `unit` (an apartment, suite or unit), `address` (the address could not be pinned to
  one house), `home` (a house a person has to look at: very large, flat or hard to see), `busy` (nothing could be
  measured right now: the company's daily limit, or the address lookup is down), `satellite-unusable` (the satellite
  pictures of the home are not clear or recent enough to measure the roof; see "Roof not measurable from satellite"
  below). The token is still returned: the
  contact and booking calls work. Windows calls are refused (`callback_only`). Example (without the `requestId`, `token`
  and `expiresAt` that every `201` carries):
  `{"status":"callback","callbackReason":"unit","home":{"address":"2200 Riverfront Dr Apt 1203, Omaha, NE 68102","floors":null,"outline":null},"estimate":{"windows":null,"roof":null},"services":["windows","roof"]}`
- `home.floors`: 1, 1.5, 2 or 3, or `null` when the height is not known. `home.outline`: the main roof's corners as
  `[longitude, latitude]` (`ring`, closed or not) and its `center`, to draw on the app's own map, or `null`. There is no
  photo of the house.
- `estimate.windows`: a count from the walls: `likely` is the number the quote uses, `low` to `high` is the plausible
  range (equal when the walls are clear; wide when the number of floors is not known, as above). `null` when windows were
  not asked for or cannot be counted.
- `estimate.roof`: a price range in dollars (rounded out to hundreds) and the roof's size in squares. `null` when roof
  was not asked for or could not be priced.
- `estimate.roofNote`: `{ "reason": "satellite-unusable", "message": "<sentence>" }`, present when roof was asked for but
  the satellite images cannot be trusted for this home (see below). Then `estimate.roof` is `null`: show `message`, no roof price.
- There is no gutters estimate: gutters are not offered to homeowners (until October 2026 `estimate.gutters` said
  `"at-visit"`; the field is gone).

### Roof not measurable from satellite

The owner's rule: for a home with inaccurate images, say the roof cannot be examined through satellite. The server
(`quote/gates.ts` `satelliteGate`) checks the roof's images for every home it measures, and any one of these makes them
unusable for the roof:

| Check | Limit |
| --- | --- |
| Google Solar `imageryQuality` | anything below `HIGH` (MEDIUM, LOW, BASE): the roof checks were benchmarked on HIGH only |
| Google Solar `imageryDate` | older than 5 years (`QUOTE_GATES.maxImageryAgeYears`) |
| The home's `yearBuilt` (when the company has it) | the imagery's year or later: the house is not in the picture |
| Solar building | none within 30 m of the home |
| The roof in 3D | a serious ("block") review reason except `edges-unverified`: roof hidden, inferred, from lidar, ... |
| Outline vs the geocoded house | the point is more than 10 m outside the measured outline, or the outline has `outline-off` / `joined-buildings` |

The homeowner hears one thing, whatever the cause: "We can't measure your roof from satellite images — the pictures of
your home aren't clear or recent enough. We'll measure it at your free visit." (`SATELLITE_UNUSABLE_MESSAGE`). Staff keep
the cause: the stored estimate's `result.satellite` (`problems`, `quality`, `date`) and a line on the job's timeline.

- Roof asked for with windows: `status: "ready"`, `estimate.windows` as normal, `estimate.roof: null`, `estimate.roofNote` set.
- Roof asked for and nothing else priceable (roof only): `status: "callback"`,
  `callbackReason: "satellite-unusable"`, `estimate.roofNote` set. Booking and contact work.
- Windows only: nothing changes (no note). The exception is a problem with the outline itself (wrong house, joined
  buildings): windows are counted on that outline, so with roof asked for it is the callback above; without it, `home`.

## GET /requests/:id

Needs the token. The view of the whole request, and the answer to every change below.

```json
{
  "request": {
    "id": "d1a18ca3-63ed-447f-b53a-e1f6276ccf71",
    "status": "ready",
    "services": ["windows", "roof"],
    "home": { "address": "4810 Underwood Ave, Omaha, NE 68132", "floors": null, "outline": { "ring": ["..."], "center": [-96.124708, 41.3015969] } },
    "estimate": { "windows": { "low": 14, "high": 28, "likely": 14 }, "roof": { "low": 12900, "high": 16500, "squares": 26.5 } },
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

(This example is cut: `windows` shows the first of three windows, `request.home.outline.ring` is shortened, and
`quote.tiers` shows Good only; a real answer has all of them, and Good, Better and Best.)

- `windows` are the homeowner's own, newest last. `rooms` lists the distinct rooms of the windows now on the request, in
  order of first appearance in `windows` (for the room picker's "recent" row); a room goes when its last window is deleted.
  Each window is sent back as it was saved plus the server's sizing.
- `quote` is `null` when the request is not about windows or is `callback`. Otherwise `tiers` is always **Good, Better
  and Best**, with the platform's standard names, descriptions and prices, the same for every company for now (a company's
  own window prices are not behind this quote yet). For each tier `total = sum(perWindow.price) + estimatedTotal`.
  **Measured** windows are priced at their own size class (small up to 72 united inches, standard to 101, large to 120,
  picture above); the windows not measured yet (`estimatedCount`) are priced from the address estimate (or from
  `estimatedTotalOverride`) and stay "estimated" in the app. `estimatedCount` is `max(0, expected windows - measured
  windows)`, where expected is `estimatedTotalOverride`, else `estimate.windows.likely`, else the number measured. With
  nothing measured the quote is all estimated; and when the address has no window estimate (`estimate.windows` is `null`)
  and nothing is measured and no count was given, every tier is `total: 0` with `estimatedCount: 0`: show no price yet.
- `missingHint` is present only when at least one window is measured, `estimatedTotalOverride` is `null`, the address has
  a window estimate, and the measured count is below its `low`. Show `text` as "Did we miss any?".
- `booking` is present on a filed request (after `.../contact`) while it has a visit that is still on, or the homeowner
  asked to be called: `{ "visit": { start, end, timeZone } | null, "callMe": boolean }`. A visit the office cancels takes
  `booking` away again.
- `status` is absent until `.../contact` was called; then it is the same body as `GET .../status`.
- Optional keys are left out, never `null`: `windows[].label`, `windows[].uploadId`, `windows[].corners` (a room scan with
  no photo), `request.callbackReason` (unless `callback`), `booking`, `status`, `status.rep`, `quote.missingHint`. Keys
  that are always there but can be `null`: `request.estimatedTotalOverride`, `home.floors`, `home.outline`,
  `estimate.windows`, `estimate.roof`, `quote`, `booking.visit`, and `status.dates.*` except
  `requestedAt`.
- A window is **`quality: "check"`** when it is not a good measure (`reasons` says why in plain words, `uncertaintyLabel`
  says how far off it may be). A `check` window still counts in the quote; the free visit re-measures every window.
- `sizeLabel` is width x height to the nearest 1/8 inch. `uncertaintyLabel` is the larger of the two uncertainties,
  rounded **up** to the next 1/8 inch ("about ±1/8 in"); never show a bare "±".
- Rounding: AR sizes are kept to 1/100 inch, the others to 1/10 inch.

## POST /requests/:id/uploads

One photo for a window. Send the file's bytes with `Content-Type: image/jpeg` (or `image/png`) and a `Content-Length`
(any `URLSession` upload of a `Data` or a file sets one), or a `multipart/form-data` body with the file in the field
`photo`. At most 12 MiB, 20,000 pixels on a side and 120 megapixels; the bytes are checked, not the declared type. A HEIC
is refused (set the camera to JPEG: Settings > Camera > Formats > Most Compatible). Keep the photo's EXIF: the server
reads the orientation, the 35 mm-equivalent focal length and the time taken; with no focal length it assumes 26 mm and
makes the "about ±" larger (more windows come back `check`). Every pixel coordinate you send later is in the photo **as
displayed** (EXIF orientation applied).

Only a few photos are received at once (3 per request, 6 per IP address, 12 in all on one server): over that the answer is an
immediate `429 rate_limited` with `Retry-After: 3` and nothing is stored, so it is safe to wait and send it again. A photo
that stops arriving for 20 seconds, or takes more than 3 minutes, is cut off.

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

- `id`: made by the app (1 to 64 of letters, digits, `_`, `-`; case counts; a UUID is fine). **Idempotent**: sending the
  same window again (a retry after a lost answer) answers **200** with the view and changes nothing; a window with the
  same id that differs in any field (room, label, style, scale, `uploadId`, corners) is `409 window_id_taken`. A new
  window is **201**. There is no call to edit a window: `DELETE` it and send it again (the id can be reused).
- `room`: 1 to 40 characters (the picker's name or typed). `label`: optional, up to 80. `style`: one of the company's
  `windowStyles` keys.
- `scale` (one of):
  - `{ "kind": "ar", "pointsM": [[x,y,z] x4], "trackingLostCount": 0, "device": "arkit" | "arkit-lidar" | "webxr", "cornerSpreadM"?: [n,n,n,n] }`
    the four frame corners in AR space, metres, each within -50 and 50 (any order: the server orders them by gravity);
    `trackingLostCount` 0 to 1000; each `cornerSpreadM` 0 to 0.1; the iPhone sends `arkit` or `arkit-lidar`. `uploadId` +
    `corners` (the same four corners as pixels in the photo) are required.
  - `{ "kind": "roomplan", "widthM": 0.9, "heightM": 1.5, "confidence": "low" | "medium" | "high" }` straight from a room
    scan (each side above 0 and at most 50 m; the size must come to 6 to 200 in). Quote-grade: always `check`, never less
    than 1 inch of uncertainty. `uploadId` and `corners` are optional (a room-scan window may have no photo), but `corners`
    without an `uploadId` is a `400`.
  - `{ "kind": "card", "cardCorners": [[x,y] x4], "card": { "widthMm": 85.6, "heightMm": 53.98 } }` a credit card (any
    ID-1 card: credit, debit, driver licence) lying flat on the glass. `cardCorners` are the card's four corners as
    tapped on the photo (tap the tip of each rounded corner), in order around the card, starting at any corner,
    clockwise or not. `uploadId` + `corners` (the window frame's four corners: top-left, top-right, bottom-right,
    bottom-left, in an upright photo) are required. `card` must be 85.6 x 53.98 mm (either way round, 0.05 mm of slack).
    Quote-grade: its uncertainty grows with the window's size next to the card, and it is `check` above 3/8 inch, and also
    when the camera is more than 50 degrees off square, the lens is wider than 20 mm (35 mm-equivalent, from the EXIF), the
    card is under 1.5% of the photo's long side, or the marked card does not look like a flat card; `reasons` says which
    (see "Card photo" and `docs/windows/card-method.md`). The server only checks the declared `card` size, so a card that
    is not really on the glass is not refused, only less accurate.
- All pixel coordinates are in the photo as displayed, inside `0..widthPx` and `0..heightPx` of that upload.
- The answer is the same view as `GET /requests/:id` (so the app has the new quote and the window's size at once).
- `422 window_unsizable`: the window cannot be sized (the `error` sentence says what to redo; `field` is `"scale"`).
  Nothing is saved. A corner outside the photo, or an `uploadId` that is not one of this request's photos, is a `400`
  (`field` `corners` or `uploadId`).
- Homeowner windows are **quote-grade only**: the company re-measures at the free visit before any factory order.

Real answers for the three kinds, from the demo (a 36 x 60 window by card, a 30 x 48 window by AR, a 1.8 x 1.2 m room scan):

```
w-kitchen-1  card      36 x 60      about ±1 in      check   standard  "The card is small next to this window, so the size could be off by about 1 inch. ..."
w-bedroom-1  ar        30 x 48      about ±1/2 in    good    standard
w-living-1   roomplan  70 7/8 x 47 1/4  about ±1 1/2 in  check  large   "A room scan gives a rough size. We measure again at your free visit."
```

## DELETE /requests/:id/windows/:windowId

`200` with the view without the window. A window that is not there is also `200` (a retried delete is harmless), also on a
request that went to the call-back path. Only the homeowner's own windows can be removed this way. The photo it stood on
stays on the request (it still counts toward the 90).

## PATCH /requests/:id

Body `{ "estimatedTotalOverride": 18 }`: the homeowner says "I have 18 windows" (1 to 80 in all, measured ones included).
`null` takes it back to the address estimate. `200` with the view. This changes `quote.estimatedCount` and drops
`missingHint`. (In the walk-through below, 2 windows measured and 18 in all gives `estimatedCount: 16` and no `missingHint`.)
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
- `phone` is any US number (up to 40 characters); stored as E.164. `zip`: 5 digits, or ZIP+4 with the hyphen
  (`68132-1234`). `email`: a valid address (up to 254; stored in lower case). Names: 1 to 60 characters, trimmed.
- `201` when this call made the lead. `200`, with the lead as it already stands, when it already existed: the same phone
  again on this request, or the same phone and the same house within 24 hours from another request (from the app or the
  web page; no office alert is made again). In a `200` **nothing is updated**: the first submission's name, email, ZIP and
  consent stand, whatever was sent now. There is no call to change the details or the consent afterwards (the homeowner
  tells the company, or replies STOP to a text). Both answers carry the view (`request.contactFiled: true`, `status`).
  Another phone number for the same request is `409 contact_filed`.
- A second request that joins an existing lead sees that lead's visit and status (it is the same person's lead).

## GET /requests/:id/slots

`{ "timeZone": "America/Chicago", "slots": [{ "id": "2026-10-17T13:00:00.000Z", "start": "2026-10-17T13:00:00.000Z", "end": "2026-10-17T14:00:00.000Z" }, ...] }`.
The next open in-home visit times, from tomorrow, at most two a day, up to 8 (the demo answers 8, over the next few working
days). With booking off the answer is `{ "timeZone": "UTC", "slots": [] }`; with booking on but nothing open, `slots` is
empty and `timeZone` is the company's real zone. Either way offer "Call me". Show the times in `timeZone`, not the phone's
own. No inspector is named before a visit is booked.

## POST /requests/:id/book

Needs `.../contact` first. Body is **one** of `{ "slotStart": "<a slot's start>" }` or `{ "callMe": true }`.

- `slotStart`: books the free in-home visit; send a `start` from `.../slots` (any visit time still open from tomorrow up to
  14 days ahead is accepted, but only the listed ones are offered). The job moves to Inspection with the visit on the
  calendar, the office's "call the homeowner" reminder is cleared. `200` with the view and `booking.visit` (and
  `status.rep.name`, the inspector's first name). A time that was taken is `409 slot_taken` and the request still stands.
- `callMe`: the homeowner asks to be called to set up the visit. The job keeps its "call the homeowner" reminder.
  `200` with `booking: { "visit": null, "callMe": true }`.
- Booking again after a visit is booked answers `200` with the visit already booked, whatever is sent (a second time is
  not booked, not even a different `slotStart` or `callMe`). Two bookings at the same moment (a double tap) make one
  visit: both answers carry it.
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

`stage`: `requested` (asked, nothing booked), `visit-booked`, `measured` (the company put windows of its own on a
measurement of the address, or the job reached Proposal or Won), `ordered` (a factory order is ready or sent),
`built`, `shipped`, `installed`. `built` and `shipped` are reserved: the server does not send them yet. The stage is
worked out on every call from the company's records, so it can move back (the office cancels the visit: back to
`requested`) and can skip ahead. `measured` and `ordered` count only what the company did **after the request was sent**
(`.../contact`); earlier work at the address is never shown. `rep.name` is the first name of the visit's inspector, or
failing that of the person the job is assigned to, so it can appear before a visit is booked. `status` is also valid
before `.../contact` (it is then `requested`).

## Card photo (what the app should coach)

The credit-card method sizes a window from one photo: a credit, debit or driver licence card (all 85.6 x 53.98 mm) lying
flat **on the glass**, eight taps. It is quote-grade: on synthetic photos the uncertainty is about 1.5% of the window's
longest side, so **every window from 24 x 36 inches up comes back `check`** and a 36 x 60 window is about "±1 in". The
full study and the table of errors by window size, distance and angle are in `docs/windows/card-method.md`. Show the
`check` answer plainly ("about ±1 in, we confirm at your free visit") and keep going; do not make it look like a failure.
A card window is also `check` when the camera is more than 50 degrees off square, the lens is wider than 20 mm (35
mm-equivalent), the card is under 1.5% of the photo's long side, or the marked card does not look like a flat card:
`reasons` says which, in words for the homeowner.

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
  "Homeowner app" and a timeline line like: "Homeowner app request. Asked about windows, roof. Shown: Roof about 26.5
  squares, $12,900 to $16,500; 3 windows measured in the app (2 to check): Good $8,750, Better $11,650, Best $17,450 for 14
  windows (11 estimated)."
- The owner's **Today** list shows "Call the homeowner about their app request" until a visit is booked.
- Booking a time adds the inspection to the calendar and a line on the timeline; "call me" adds a line and keeps the reminder.
- The progress the app shows (`measured`, `ordered`) is what the company did at the address after the request came in.
- The **consent** is on the quote request (the words, the version, the time, an IP hash); the customer's texting consent
  stays "none".
- **Measure windows** on that address (a rep's new measurement, in the web app or the iPhone staff app) starts with the
  homeowner's windows: named by room, tagged "Homeowner app", marked `source: "homeowner-app"`, with their photos. They
  are quote-grade: on a factory order they are quote-only lines until the rep measures them again. Windows from a
  request the homeowner never sent in (no contact form) are not copied; the homeowner's own copy is never the address's
  "newest measurement" for staff (it has no walls or street photos and would hide the company's own earlier one).

## The instant quote page and the app

`/q/:slug` (the company's web page) starts with "What are you looking for?" (roof, windows; never gutters). The windows
result is a **count** with its plausible range ("About 14 windows (12-16)", from the same walls estimate as
`estimate.windows`), never a price. The way to the exact price depends on the device and appears only when the server has
`HOMEOWNER_APP_URL` (the App Store or TestFlight link; the name is `HOMEOWNER_APP_NAME`, default `WinChoice`; the page's
config, `GET /api/public/quote/:slug`, carries `homeownerApp: { url, name } | null`):

- iPhone (and iPad): the button "Download the WinChoice app to measure your windows" to the store link.
- Android: "Measure your windows in your browser", to `/q/:slug/measure?request=<quote id>` (the page itself is built
  separately; today it says it is coming).
- A computer: a QR code of that measure link, "Scan with your phone: iPhone opens the app, Android measures in the browser".
- Everyone: the small link "Book a free visit and we'll measure" goes on to the request form. With no `HOMEOWNER_APP_URL`
  it is the only way on, as the main button.

The roof keeps its price range ("Final price after a free in-home visit"), or the satellite sentence above.

## Trying it on this machine

```sh
npm run demo        # app on http://localhost:4500, database on 54339 (DEMO_PORT, DEMO_DB_PORT, DEMO_COMPOSE_PROJECT change them)
```

- The demo company is **Summit Ridge Roofing**, slug `summit-ridge`: windows and roof on for homeowners (gutters are on for staff), online booking on.
  The API is `http://localhost:4500/api/public/homeowner/summit-ridge`; the web page is `http://localhost:4500/q/summit-ridge`.
- With no keys, the demo's address lookup puts any typed address on one of its real Omaha houses: the outline, roof size
  and window count come from that house. With `.env.keys` it uses real lookups (a few cents per new address; repeats within
  30 days are free).
- With no Solar key the demo's fake Solar gives recent HIGH imagery everywhere except every eighth lookup lot: type
  `107 Faded Photo Ln, Omaha, NE 68124` to see the "can't measure your roof from satellite images" path (LOW imagery from 2014);
  `4810 Underwood Ave, Omaha, NE 68132` is a normal house.
- `HOMEOWNER_APP_URL` is a placeholder App Store link in the demo, so the page shows the app offer.
- The demo listens on `127.0.0.1` only. The iOS Simulator reaches it at `http://localhost:4500`; a real iPhone needs a tunnel.
- Sign in at `http://localhost:4500` as `owner@summitridge.test` / `summit-ridge-demo` to see the lead (Jobs, Today, the
  job's timeline) and, in Measure windows, the homeowner's windows.

The same walk with `curl` (needs `jq`). `B` is the base; the commands are the ones that produced the output above.

```sh
B=http://localhost:4500/api/public/homeowner/summit-ridge

# 0. A synthetic photo for steps 3 and 4 (a 36 x 60 in window with a credit card on its glass, 3024 x 4032, EXIF 26 mm).
#    Run this first from the repo root; it makes a scratch folder, writes photo.jpg there and prints the corners step 4
#    sends. Keep that folder as the current one for the steps below. Any real phone photo works the same way.
REPO=$PWD; cd "$(mktemp -d)"
cat > card-photo.ts <<EOF
import { writeFileSync } from 'node:fs';
import { cardScene } from '$REPO/apps/api/test/homeowner-fixture.ts';
const s = cardScene({ windowIn: { w: 36, h: 60 }, distanceM: 1.6, yawDeg: 10 });
writeFileSync('photo.jpg', s.bytes);
console.log(JSON.stringify({ cardCorners: s.cardCorners.map((p) => p.map(Math.round)), corners: s.windowCorners.map((p) => p.map(Math.round)) }));
EOF
$REPO/node_modules/.bin/tsx card-photo.ts
#   -> {"cardCorners":[[1437,1968],[1587,1969],[1587,2063],[1437,2064]],"corners":[[644,532],[2312,675],[2312,3357],[644,3500]]}

# 1. The company (the consent words and version)
curl -s $B/company | jq '{name, services, booking, consent: {version: .consent.version}}'

# 2. A request: the home, the estimates, the token (shown once)
curl -s -X POST $B/requests -H 'Content-Type: application/json' \
  -d '{"address":"4810 Underwood Ave, Omaha, NE 68132","services":["windows","roof"]}' > req.json
REQ=$(jq -r .requestId req.json); TOKEN=$(jq -r .token req.json)
jq '{status, estimate}' req.json

# 3. A photo (a phone photo keeps its EXIF; every pixel below is in the photo as displayed)
UP=$(curl -s -X POST $B/requests/$REQ/uploads -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/jpeg' --data-binary @photo.jpg | jq -r .id)

# 4. A window: card on the glass, four taps on the card and four on the frame (here a 3024 x 4032 photo)
curl -s -X POST $B/requests/$REQ/windows -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "id":"w-kitchen-1","room":"Kitchen","label":"Over the sink","style":"double-hung",
  "scale":{"kind":"card","cardCorners":[[1437,1968],[1587,1969],[1587,2063],[1437,2064]],"card":{"widthMm":85.6,"heightMm":53.98}},
  "uploadId":"'$UP'","corners":[[644,532],[2312,675],[2312,3357],[644,3500]]}' \
  | jq '{window: (.windows[0] | {id, sizeLabel, uncertaintyLabel, quality}), good: (.quote.tiers[0] | {total, estimatedCount})}'
#   -> { "window": { "id": "w-kitchen-1", "sizeLabel": "36 x 60", "uncertaintyLabel": "about ±1 in", "quality": "check" },
#        "good": { "total": 8450, "estimatedCount": 13 } }

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
windows call on a roof-only request   409  {"error":"This request is not about windows.","code":"windows_not_requested"}
a key the API does not know           400  {"error":"Please check this field.","code":"invalid_request"}   (no field: it is the whole body)
a photo that claims too many pixels   415  {"error":"Upload a JPEG or PNG photo.","field":"photo","code":"unsupported_media"}
a path that is not in the API         404  {"error":"We couldn't find that.","code":"not_found"}
the sixth contact call in an hour     429  Retry-After: 3600
                                           {"error":"That's a lot of tries from this connection. Please try again in an hour, or give us a call.","code":"rate_limited"}
```

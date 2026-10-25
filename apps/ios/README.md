# iPhone apps (WinChoice and Roofline Measure)

Two SwiftUI apps, one Xcode project (XcodeGen), one logic package (`Core/`, RooflineCore), iOS 17+:

| App | Who | Scheme / bundle id | Where |
|---|---|---|---|
| **WinChoice** | the homeowner: measures their own windows room by room, gets a price, books the free visit | `WinChoice` / `com.premjeetech.winchoice.measure` | `RooflineMeasure/Homeowner/`, brand in `RooflineMeasure/Brand/WinChoice/` |
| **Roofline Measure** | the rep, on site (jobs, windows, outbox). Parked: its screens compile only with the `STAFF_APP` flag, which only this target sets, so none of it is in the WinChoice binary | `RooflineMeasure` / `com.premjeetech.roofline.measure` | the rest of `RooflineMeasure/` |

Both share the AR corner measure (`AR/ArMeasureController.swift`), the room scanner (`RoomPlan/RoomScanner.swift`) and the
device checks (`Shared/`). The homeowner app's design is `~/RooflineWork/design/REDESIGN.md` sections 7 and 8 and the mockups in
`design/mockups/` (`ios-hw-*.png`); its brief and the API contract are `plans/homeowner-app.md` and `docs/windows/homeowner-api.md`.

## WinChoice (the homeowner app)

### The journey

Welcome (what are you looking for) > Address (map pin) > Results (roof price, window count) > Tips > Rooms > Method >
**Measure** > Label sheet (room and name) > Windows list ("Did we miss any?") > Style per window > Quote (Good / Better / Best) >
Contact (consent) > Visit time (or "Call me to pick a time") > Booked (Add to Calendar) > My order (status, windows, messages).
Branches: an apartment, duplex or address the server will not price goes to **Call-back** (03b: a phone number, then the contact
form, then "We'll call you"); a roof-only request skips the window screens. It resumes where the homeowner left off
(the request id and bearer token are in the **Keychain**, the last screen and rooms in UserDefaults).

The results screen opens with the home from above (`Screens/HomeHero.swift`, `HomeOutlineGeometry.swift`): Apple's satellite
imagery (MapKit only), the camera settling on the house, the server's roof ring (`home.outline.ring`, longitude/latitude) drawn
round it on the map's own projection (`MapProxy`), then the cards. About 2.5 s, plays once per request, a tap skips it, and it never
holds back the price (the pinned button is there throughout). With no outline, or when the phone is offline, it is the small static
card as before.

Four ways to measure, each saved as one window:

- **Quick scan (Apple)** (RoomPlan, depth-sensor iPhones; listed first on the method screen, "Recommended for speed"): point at the wall with
  the window, pan a few seconds, Done (the button waits 3 s, `ScanProgress`). While it runs, RoomCaptureView outlines the windows and a bar
  says "2 windows found" with each one's size so far (`ScanHud`, fed by the capture session's `didUpdate`). The review lists each window
  with its photo and outline, its size to the eighth and "Apple's scan · fairly sure"; a wrong one can be left out, the room named. If the
  finished room has no window or cannot be built from a short pan, the windows seen while scanning are used (`ScanFinish`); none at all
  is "We didn't find a window" with Scan again and the photo method. Scale kind `roomplan`, quote-grade ("check"), no accuracy number claimed.

- **Tap the 4 corners** (ARKit, any iPhone with AR; a depth sensor is "about 1/4 inch · best"): `ArMeasureController` with the
  tape-style HUD, scale kind `ar`.
- **Scan the whole room** (RoomPlan, depth-sensor iPhones): finds every window in the room, a 3D / plan review where each can be
  left out or moved to another room, scale kind `roomplan`. A window is a level rectangle (`RoomWindowShape`, Core): RoomPlan's
  `dimensions`, or its `polygonCorners` when those are four square corners that agree with the dimensions (else the dimensions stand and
  the confidence drops a step).
- **Photo with a bank card** (any iPhone with a camera): one photo with a card flat on the glass, tap the card's four corners and
  the frame's four with a magnifier; the phone shows the size live with `CardSizing` (a Swift port of the server's model, checked
  against the real server's answers), scale kind `card`. Orientation is applied to the pixels and the 35 mm focal length is the only
  EXIF tag kept (no location).

**The phone proposes the corners** (Apple Vision only, on the phone, no network), so the person usually just confirms:

- *Photo with a card*: when the photo is taken, `WindowRectangleDetector` (Vision's rectangle finder, `AR/`) looks at a 1600 px copy,
  then at a full-size crop round the card. `AutoCorners` (Core) decides: the card is the small shape in a card's proportion (85.60 : 53.98,
  either way round) that lies inside a believable window; the window is the largest believable shape (not the photo's own border, not a
  card-sized one), stepped in once from casing or trim to the opening that holds all the panes ("the inside of the frame"). The card's
  outline is moved in by the rounded-corner tip inset, since the model takes taps at the tips. The corners are put on `PhotoTapView` with
  "We found your card. Drag a corner if it's off."; nothing found with confidence means silent manual tapping, as before.
- *Depth/AR corners* (the homeowner app): see the next section. The phone proposes the corners on a frozen photo, not on the live camera.
  `cardauto` and `windowauto` run the real photo detection on the sample photo.

**Measuring from a frozen photo** (depth/AR corners, homeowner app). Tapping a corner with a held phone, or watching an outline that
jumps with every shake, is where wrong sizes came from, so the window is marked on a STILL, as a rectangle:

1. The camera finds the wall (`ArMeasureController`, as before). The person aims the circle at the window and taps **Capture**
   (`ArCaptureHud`); the phone waits up to 0.7 s for a still hand, then freezes that one `ARFrame` (`ArFrameEngine.freeze`,
   `AR/FrozenCapture.swift`): the upright JPEG, camera pose and lens numbers, the locked wall plane, and the LiDAR depth and confidence
   copied into plain arrays (`FrozenDepth`).
2. The frozen photo opens in `FreezeFrameEditor`, which holds the window as a `FrozenRect` (Core): four edges (left, right, top, bottom,
   level with gravity) on the frame's plane. **The phone starts it from the server's AI window finder when that answers** (below), else from
   the DEPTH SENSOR (`OpeningFinder`): a window is where the wall isn't.
   Depth pixels behind the wall's plane by more than 2 cm, or with no/low-confidence reading (glass), that are connected to the middle of the
   picture are the opening; things in FRONT of the wall (more than 6 cm: a lamp, a valance) are neither wall nor window and never decide an
   edge. Each side is the median of the opening's boundary along that side, counting only where the boundary pixel touches the wall's own
   depth, so a lamp over a corner or a valance cannot move it; blinds hung inside the recess are just opening. Each side is then set onto the
   strongest edge in the photo within 3 cm of it (`CornerSnap.edgeLine`, Sobel + Hough) when the picture is clear, else it keeps the depth's
   edge. Only when depth finds nothing (no LiDAR, the middle on a solid wall, an opening cut off by the picture) does Vision's
   rectangle finder run: the largest believable outline that holds the middle of the picture, and never one smaller than 15 in on a side
   (`OpeningFinder.isPlausible`; a sash or a pane is not a window). Nothing found: the rectangle starts inset and the hint says to drag.
   **AI window finder** (`Measure/AiFinding.swift`, Core `AiWindow.swift`): after Capture the photo, cut down to about 1024 px on its long
   side (JPEG 0.7), goes to `POST .../detect-windows` (OWLv2 finds the window boxes; with `WINDOW_SEGMENTER=sam2` SAM 2 cuts the picked window
   out and a line fit turns its mask into four corners, `quad`, with a `quality`). Only when online with a request saved; 6 s timeout, one try.
   While it waits (after 0.5 s) the rectangle starts inset with a small "Finding your window..." spinner and can be dragged at once; a
   proposal that arrives after the first touch is not put over the person's rectangle. `WindowProposal.choose` decides: the box that holds the
   photo's middle (best score; of nested boxes the largest within 70% of it), as the quad when its `quality` is 0.7 or more, else as the box;
   its corners are raycast to the frame plane and the level rectangle is each side set onto the strongest edge in the photo within 6 cm
   (`OpeningFinder.refineSides`, wider than the depth path's 3 cm). If the depth opening overlaps that rectangle on the photo (IoU over 0.6) the
   depth opening is used (better measured); if they disagree the AI wins; Vision runs only when neither exists.
3. The four dots ARE the rectangle's corners (the outline goes exactly through them) and a square on the middle of each side moves that
   side only. Dragging a corner moves the two edges that meet there, so its neighbours follow (`FrozenRect.moved`); the dot stays under the
   finger (no gain; a magnifier shows it above the finger) and pinch zooms. A corner let go within about 25 px of a frame corner snaps onto it
   when both edges are strong and clear (`CornerSnap`); the snapped point is then converted to the edges. After each drag the depth round the
   corners says again where the frame's face is (`FrozenView.framePlane`, `FrozenRect.rebased`), keeping the dots where they are.
4. What is drawn is what is measured is what is sent: `FrozenMeasure.measure(rect:)` sizes the rectangle's own four corners
   (`sizeFromArPoints`), and the two plates, the status card, the label sheet and the server get that one width and height. Nothing is
   fitted or averaged after the finger lets go. A rectangle cannot disagree with itself, so the old "corner N looks off" is gone from the
   editor; `RectangleFit` stays in Core for the corners-as-tapped path.
5. **Take another photo to double-check** (up to three of the same window, same tracking session; a restart sets the earlier ones aside):
   this photo's rectangle is what is sent; the earlier photos are only a check. Corners more than 3/4 in apart say so and mark the window a
   check (`FrozenMeasure.combine`, `withDoubt`).

**Standard sizes** (`Core/StandardWindowSizes.swift`): the editor's status card, the window list and the label sheet say "Looks like a standard
24 × 36 window" when BOTH measured sides are within an inch of a common double-hung or slider size (or of it less a half inch, the unit size).
It is a suggestion on the screen only: the measured size is what is sent and priced.

**Two sizes for one window** (`Core/WindowFrameFinder.swift`, `WindowFrameSize`, `TwoSizes`): the rectangle the person confirms is the OPENING (where
the wall stops: trim or casing's inner edge). It is shown big ("Opening 34 5/8 × 55 3/4 in"), drawn as the yellow outline, and is the only thing sent.
Just inside it is the WINDOW's own frame, about 1 to 2 cm in on each side, which is what a tape across the window reads. After the rectangle settles
(proposal applied, or a dot let go) the editor looks for that inner edge in the photo, off the main thread: from each side of the opening it samples
the photo across the side from 0.6 cm to 8 cm in (through the plane's own projection, so a window seen at an angle is searched where it is), measures
the step in brightness at each depth, and takes as the edge the step that at least half of the places along the middle 80% of the side agree on
(a percentile, so a long line counts and a cord or a latch does not). The FIRST clear edge inward wins, not the strongest (slats and cords make
stronger lines further in); two opposite edges within 9 mm are one thin line and go; the sides' insets must agree (about the same frame thickness all round) or
the odd one is dropped, and a missing side takes the median of the others; fewer than two sides: no window size (nothing is shown, the opening stands
alone). It is shown as "Window about 33 1/4 × 54 3/8 in" under the opening's size, a thinner dashed line inside the yellow one, a second line on the
window list row and the label sheet, and the standard-size line goes by the window's size when there is one. The server has no place for it (a window
body with an unknown key is a `400`, `label` is the homeowner's own name), so it stays on this phone by window id (`HomeownerProgress.windowFrames`,
`PendingDisk`). Limits: a frame recessed behind the opening reads a little further in than it is (parallax), and a blind that hides the frame's edge
on most of a side (the owner's capture `c454e67a`) leaves nothing to find. `-debugOpen freeze-frame` and `label-frame` show both on the drawn sample;
`RooflineReplay` prints each side's candidate edges and the window size.

**Debug dump and replay** (Debug and TestFlight builds only, `BuildEnvironment.isTesterBuild`): each Capture's full photo, depth and confidence,
lens, camera pose, wall plane and, when the AI answered, its answer, then the source, the proposed rectangle and the final one, go to
`POST .../debug-captures/:captureId/:file`, which exists only when the server has `DEBUG_CAPTURES_DIR` (files in `<dir>/<captureId>/`, no
database). The format is `Core/DebugCapture.swift`. On a Mac, `cd apps/ios/Core && swift run RooflineReplay <that folder> [--boxes answer.json]`
re-runs the depth finder, the AI pick and the refine on the real data and prints the rectangle beside what the phone proposed and what the
person used. `-debugCaptureDir <path>` writes the dump to a local folder instead (simulator).

`-debugOpen freeze` runs steps 2 to 4 on the drawn sample photo (a frozen frame with a synthetic depth map); `freeze-clutter` adds the
owner's window (blinds over the top, a lamp in front of a corner, a valance above, a picture beside it), `freeze-off` starts from a
rectangle that is off the frame, `freeze-two` from an earlier photo that disagrees, `hud` shows the Capture screen.

The older live path (reticle, hold still, tap each corner) is unchanged for the rep app (`MeasureChooserView`).

Wording rules (`Core/Sources/RooflineCore/SizeWording.swift`): whole inches and eighths ("35 5/8", never a decimal), accuracy rounded
**up** and written "about 1/4 inch" (a plus-or-minus only ever follows "about"), "depth sensor" not "LiDAR", "bank card" not "ID-1".

### The server

Everything goes through the `HomeownerAPI` protocol (`Homeowner/API/`): `LiveHomeownerAPI` (HTTP, bearer token, the server's
`{ error, field, code }` errors, one retry after a short 429) and `FakeHomeownerAPI` (in memory, the same rules: windows idempotent
on id, 409 for a different window with the same id, consent version, 60 windows). Endpoints used, under
`/api/public/homeowner/:slug`: `GET company`, `POST requests`, `GET requests/:id`, `POST requests/:id/uploads` (raw JPEG),
`POST requests/:id/detect-windows` (raw JPEG, best-effort, the AI window finder), `POST requests/:id/debug-captures/:captureId/:file` (testers only),
`POST requests/:id/windows`, `DELETE requests/:id/windows/:windowId`, `PATCH requests/:id` (`estimatedTotalOverride`),
`POST requests/:id/contact`, `GET requests/:id/slots`, `POST requests/:id/book`, `GET requests/:id/status`.
`HomeownerFeatures.contract` (the live client) hides what the API does not carry yet (window colour, best time to call, order
number and ship date); the fake shows them (`.all`) unless `-debugStrict`.

The **outbox** (`Core`'s `Outbox` with `HomeownerOutboxTransport`) keeps every window on disk until the server has it: the photo goes
up at once, the window waits for its style (a style is required), then it is sent; a retry is safe. A 429 is not a refusal: the live
client waits a short `Retry-After` (up to 10 s) and tries once more, a longer one is kept on the item (`retryNotBefore`) and the outbox
leaves it alone until then; the window list says so calmly in the server's own words.

### Brand

`RooflineMeasure/Brand/WinChoice/WinChoice.json` (name, quote slug, colours, what the tiers include, the made-in line, the server
for Debug / Release), the target's `Info.plist` and `PrivacyInfo.xcprivacy` (no tracking, nothing but the company's own server),
the app icon. `Theme.swift` reads the colours from the JSON: WinChoice red `#ED3A2B` is the one main button of a screen, navy
`#112337` / `#061F3F` the ink and the hero, blue `#155EAB` selection and links, tape yellow only for measuring guides. The look
(Chalk Line: expanded heavy headings, mono digits for sizes, stacked fractions) is Roofline's and does not change per company. A text
wordmark, no logo. Another company = another JSON, another target.

### Accessibility

- **Dynamic Type**: every text scales (`ScaledMetric` from the mockup's size), and the layouts change instead of cutting words
  at the accessibility sizes: rows stack (`AdaptiveStack`), the nav bar puts its title under the buttons, the pinned main button
  moves to the end of the scrolling content (`wcFooter` and `WCScrollFooter`), the style grid has one column, the tab bar becomes a
  menu. Over the camera (the AR HUD, the card photo's tapping, the room scan) the controls stop at the largest ordinary size so the
  picture stays in view.
- **VoiceOver**: every control has a label (sizes are spoken in words: "35 and 5 eighths by 59 and 5 eighths inches"), headings are
  marked, the photo-tapping canvas allows direct touch, the room drawing is described, a notice is announced when it appears.
- **Targets and contrast**: 44 pt minimum targets; the quiet text colour (`ink3`) is a touch darker than the mockups' so small
  text clears 4.5:1 on every surface; the main button's label is 18 pt bold (large text, 3:1) because white on the brand red
  `#ED3A2B` is 4.0:1 (a darker red such as `#DB3425` would be 4.6:1: the brand owner's call).
- **Reduce Motion**: the press scale, the notice's slide, the zoom reset and the results screen's "finding your home" reveal are off
  (the finished satellite picture with the outline is shown at once; VoiceOver gets the same).
- **Checked by Apple's accessibility audit** (`WinChoiceUITests`, below): contrast, hit areas, Dynamic Type, clipped text and
  descriptions on every screen, light, dark and at the largest accessibility size.

### Layout

```
RooflineMeasure/Homeowner/
  App/        WinChoiceApp, RootView (navigation), HomeownerStore (+Journey, +Windows), AppEnvironment, DEBUG launch + E2E
  API/        HomeownerAPI protocol, Live and Fake, the outbox transport, the Keychain vault
  Model/      WindowRow (server and phone windows as one list), progress, address place
  Screens/    01 to 15 and the call-back screens, the label sheet
  Measure/    the AR HUD, room scan screen and review, the card photo flow, the shared photo tap view
  Theme/      Chalk Line colours and type, components, icons (the mockups' SVG paths), illustrations
RooflineMeasure/Brand/WinChoice/   WinChoice.json, Info.plist, PrivacyInfo.xcprivacy, Assets.xcassets
WinChoiceTests/       app tests (hosted): the store over the fake server, the HTTP client over a stub, the outbox, rows and wording,
                      the card flow, photo preparation, the brand and bundle
WinChoiceCoreTests/   the whole RooflineCore check suite as an XCTest (no host app)
WinChoiceUITests/     Apple's accessibility audit on every screen (its own scheme: it launches the app 37 times, about 5 minutes)
```

### Run it in the simulator

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/ios && xcodegen generate
xcodebuild -project RooflineMeasure.xcodeproj -scheme WinChoice -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build/dd build CODE_SIGNING_ALLOWED=NO
xcrun simctl boot 'iPhone 17 Pro'; open -a Simulator
xcrun simctl install booted build/dd/Build/Products/Debug-iphonesimulator/WinChoice.app
xcrun simctl launch booted com.premjeetech.winchoice.measure -debugFake -debugScenario list -debugCaps lidar
```

The simulator has no camera, AR or RoomPlan: the measuring screens show a designed "needs an iPhone" page, and DEBUG builds can
open them over a drawn window photo (`-debugOpen hud|hud-howto|freeze|freeze-clutter|freeze-off|freeze-two|label|scan|quickscan|quickscan-live|card|card3|card4|window2|window4|windowdart`, with
`-debugScenario method`). Unsigned simulator builds also have no Keychain: the app says it cannot save the request for later and carries on.

**DEBUG-only launch arguments** (`Homeowner/App/HomeownerDebug.swift`, compiled out of Release):
`-debugFake` (the in-memory server), `-debugScenario welcome|address|results|roofonly|callback|callbacksent|coaching|rooms|method|list|styles|quote|contact|book|booked|status`,
`-debugStrict` (only what the API contract carries), `-debugCaps lidar|corners|card|none`, `-debugLatency <s>`,
`-debugServer <url>` (a real server), `-debugE2E` (walk the whole journey against it with synthetic windows, printing `E2E ...`
lines), `-debugGo <step>`.

Against the real API (a local demo of the API branch, its own port and database):

```sh
cd <the API checkout> && DEMO_PORT=4680 DEMO_DB_PORT=54680 DEMO_COMPOSE_PROJECT=roofline-hoios npm run demo
xcrun simctl launch --console booted com.premjeetech.winchoice.measure -debugServer http://localhost:4680 -debugE2E
```

(the server allows 10 new requests an hour per address; a Google-backed look-up is made for each).

### Guided scan (multi-frame, like Medida)

On a depth-sensor iPhone the **Measure** step opens the guided scan first (`Measure/GuidedScanFlow.swift`; "Take one photo instead" on its first screen
goes to the single frozen photo above, which also stays the path on iPhones without LiDAR). The contract it implements is
`docs/windows/scan-contract.md`; the server re-runs the same maths and its answer wins.

1. **Aim and Start.** Apple's `ARCoachingOverlayView` finds the wall; Start locks it. 2. **Step slowly left and right** (`ScanGuide`, Core): the phone keeps 5 to 8
regular photos by itself, each at least 15 cm from every other, steady (speed and turn from the pose), sharp (variance of the Laplacian against the sharpest lately),
neither dark nor bright, and with the whole window in view once it is known. 3. **Move closer to each corner** (TL, TR, BR, BL): an arrow (or a ring when the
corner is on the screen) points to the corner; when it is centred, 0.4 to 0.8 m away, steady and sharp for a third of a second, the close-up is taken. Coaching
for each thing that can go wrong; a manual shutter, Redo, Skip, Stop. `AR/ScanRecorder.swift` runs on the AR engine's queue and keeps, per photo, the NATIVE
landscape JPEG (uploaded), an upright JPEG (what the corner finders and screens use), the pose, the lens, the wall and, for regular photos, the depth.
4. **Marks** (`Measure/ScanProcessing.swift`, Core `ScanMarkMaker`): the window's first estimate comes from the first regular photo (depth opening at once, the AI
finder after; if neither finds it the person outlines it on that photo with the single-photo editor); its four corners are projected into every photo and found
again there with `CornerSnap` (nearest ring first: 1.5, 3, 4.5 cm; close-ups wider). A corner the photo does not confirm stays a hollow projection that the maths
ignores; outliers are pruned leave-one-out; after the first solve the rectangle is projected again with a smaller search and kept when it is better.
5. **Result** (`GuidedScanResult.swift`): the best photo with the rectangle, Measured (green) or "We'll have WinChoice check this one" (amber, never a block), the
opening and window sizes, "Measured from N photos", each corner's confidence, a strip of every photo; a photo opens a sheet where a mark can be dragged
(the answer is worked out again). 6. **Upload** (`Core/ScanOutbox.swift`, `HomeownerScanTransport`): the scan is saved on disk when the result is used, armed when the
window is saved, each photo goes up the uploads route, then `POST .../scans` once the window itself is on the server; a 404 (route not deployed) keeps it queued
without a word. The server's per-window `scan.label` ("Being checked by WinChoice") shows on the window's row.

`Core/WindowScan.swift` is the contract's maths and JSON (closed-form triangulation, the level rectangle through `RectangleFit`, the seven gates);
`RooflineMeasureTests/Fixtures/window-scan/*.json` are the server's fixtures, which the Core checks run (`ScanParityChecks`). DEBUG: `-debugOpen guided-aim |
guided-hud | guided-closeup | guided-working | guided-result | guided-result-check` over a drawn window (`Measure/DebugScanSamples.swift`; the result runs the
real marks pipeline on the drawn photos).

### Tests

```sh
cd apps/ios/Core && ./scripts/check.sh                       # the logic, plain swiftc, 133 checks (or `swift run -q RooflineCoreChecks`)
cd apps/ios && xcodebuild test -project RooflineMeasure.xcodeproj -scheme WinChoice \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
xcodebuild test -project RooflineMeasure.xcodeproj -scheme WinChoiceUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO   # the accessibility audit
```

The card model's parity data (`Core/Sources/RooflineCoreCheckSuite/CardParityData.swift`) is generated from the server's real
TypeScript by `Core/scripts/card-parity/`; regenerate it whenever `packages/shared/src/window-photo-card.ts` changes.

### Only a real iPhone can show

The AR HUD (tracking, the magnifier on live depth, the live window outline and how well Vision finds real windows and real cards), the RoomPlan scan and its review on a real scan, the camera and the EXIF focal
length of a real photo, the Keychain on a signed build, Add to Calendar (EventKitUI), the location button, Dynamic Type and
VoiceOver on a phone, and how accurate each method is on real windows (`Field accuracy test` below applies to the AR and scan paths).

### Release

`SCHEME=WinChoice apps/ios/scripts/testflight.sh` (same prerequisites as below, with the app record for
`com.premjeetech.winchoice.measure`). The Release server address in `WinChoice.json` is empty until the production server exists;
TestFlight builds can enter one on the phone (hold the WinChoice wordmark on the welcome screen; Debug and TestFlight builds only), the App Store build needs it filled in.

---

# Roofline Measure (the rep app, parked)

The native iPhone app for measuring windows on site, LiDAR first. SwiftUI + ARKit + RoomPlan, iOS 17+, bundle id
`com.premjeetech.roofline.measure`. Brief: `~/RooflineWork/plans/ios-measure-app.md` (Oct 16 2026).

It talks to the same API as the web app (cookie sessions, `/api/window-measurements`), so every window it saves shows
in the web app's windows screen, sized by the server.

## What is in it

| Screen | What it does |
|---|---|
| Sign in | Email + password (`POST /api/auth/login`). Hold the title for 1 s: the hidden **Server address** setting (default `http://localhost:4500`, kept on the phone). |
| Jobs | The rep's jobs (`GET /api/jobs?assigned=me`) with their addresses, plus a search over every address (`GET /api/properties?q=`). |
| Windows | The address's latest windows measurement (`GET /api/window-measurements?propertyId=`, or start one). Windows grouped by `windowKey`, sizes in eighths with ±, a **check** badge, what is still waiting in the outbox. Add window, Measure again (swipe or long-press), Delete, All windows measured. |
| Measure | **LiDAR / AR corners** (any ARKit iPhone; LiDAR phones are order-grade candidates, others quote-grade), **Room scan** (RoomPlan, LiDAR phones, new windows only, always quote-grade), **Sheet photo** (the web app's photo screen in a web view, same session). |
| Outbox | Every saved window, on disk until the server has it: JPEG upload, then the window. Per-window error with Retry / Discard. |
| Export test data (hidden) | Settings (gear on Jobs) > tap the version line 5 times. CSV of every AR / scan pass (corners, spreads, LiDAR, tracking losses, ±) for the field accuracy test, via the share sheet. |

### The AR corner measure (the LiDAR rules)

- `ARWorldTrackingConfiguration`, gravity world alignment (+Y up), vertical plane detection; on LiDAR phones
  `sceneReconstruction = .mesh` and `frameSemantics = .sceneDepth`.
- Centre reticle + loupe. Before a wall is known the reticle uses `.estimatedPlane` raycasts; once ARKit reports a
  vertical plane there, the reticle's ray is intersected with that **infinite** plane (frame edges sit where plane
  polygons stop), moved onto the frame's face by the LiDAR depth points around the reticle.
- Tap **Place corner**: ~15 positions while the phone is held still, outliers dropped (median + MAD), averaged; the
  spread of each corner is sent as `cornerSpreadM`.
- A tap whose depth points are mostly > 5 cm off the wall is refused (through the glass).
- Tracking lost (not available, relocalising, the camera interrupted) between corners **restarts the window**; every
  loss is counted (`trackingLostCount`).
- The four corners are projected onto the wall plane (or the best-fit plane) and ordered **by gravity**, never by tap
  order. Live side lengths in eighths; Undo, Start over, a label field.
- Save keeps the current frame: `ARFrame.capturedImage` turned upright and encoded as JPEG (no orientation tag, i.e.
  EXIF orientation 1; the server refuses HEIC), corners projected into that JPEG's pixels with `ARCamera.projectPoint`
  (cross-checked against the pinhole model in RooflineCore). Step back until the whole window is on screen before Save.
- Saved as scale kind `ar` with `device` `arkit-lidar` or `arkit`.

### RoomPlan

`RoomCaptureView`; when the rep taps Done, every `CapturedRoom` window (doors too, off by default) is listed with its
size; the rep ticks and labels each. Each is saved as scale kind `roomplan` `{widthM, heightM, confidence}` with the
photo from the scan that saw it best (keyframes are kept while scanning). The server marks these `check`, ± 1 / 1.5 / 2 in
by RoomPlan's confidence (high / medium / low), never order-grade.

### Server endpoints it expects (branch ios/measure-app)

`POST /api/window-measurements/:id/photo-windows` (append one), `DELETE /:id/photo-windows/:windowId`,
`GET /api/window-measurements?propertyId=`, the optional `device` / `cornerSpreadM` on the `ar` scale and the
`roomplan` scale. Until the server has the append/delete routes, the app falls back to a PATCH of the whole
`photoWindows` list (the old way). Without the `?propertyId=` route, the Windows screen offers to start a new
measurement each time.

## Layout

```
apps/ios/
  project.yml                 XcodeGen spec (the .xcodeproj is generated and gitignored)
  ExportOptions.plist         app-store-connect upload, used by scripts/testflight.sh
  scripts/testflight.sh       generate, archive, export + upload (App Store Connect API key)
  Core/                       Swift package RooflineCore: all pure logic, no UIKit/ARKit
    Sources/RooflineCore/     geometry, plane fit, gravity order, sizeFromArPoints port, sampling, capture state,
                              eighths, image mapping, API types (Codable), outbox, test-data CSV
    Sources/RooflineCoreCheckSuite/  the checks (one list for XCTest and the plain runner)
    Sources/RooflineCoreChecks/      runner without XCTest
    Tests/RooflineCoreTests/         XCTest wrapper (swift test)
    scripts/check.sh          builds and runs the checks with swiftc only (no Xcode needed)
  RooflineMeasure/            the app (SwiftUI screens, AR/, RoomPlan/, Networking/), Info.plist, PrivacyInfo.xcprivacy
  RooflineMeasureTests/       XCTest: the Core checks + parity with the server's Fixtures/ar-sizing.json
```

The pure logic lives in the package (not in `RooflineMeasure/Core/`): SwiftPM does not allow a target's sources
outside the package folder, and one copy avoids drift. The app depends on the package's `RooflineCore` product.

## Check the logic on any Mac

```sh
cd apps/ios/Core
swift build && swift test           # with Xcode installed
./scripts/check.sh                  # Command Line Tools only (no XCTest needed)
```

`check.sh` also compares the Swift `sizeFromArPoints` with the server's numbers when
`RooflineMeasureTests/Fixtures/ar-sizing.json` exists (written by `npm run ios:fixtures` on the server branch):
width, height, ±, quality and corner order to 1e-6 in, and the constants (`ArLimits`). Another path can be passed:
`./scripts/check.sh path/to/ar-sizing.json`.

## Build and run on an iPhone

1. Install Xcode (App Store), open it once, then `sudo xcode-select -s /Applications/Xcode.app`.
2. `brew install xcodegen`
3. `cd apps/ios && export DEVELOPMENT_TEAM=<team id> && xcodegen generate && open RooflineMeasure.xcodeproj`
4. Plug in the iPhone (Developer Mode on: Settings > Privacy & Security > Developer Mode), pick it as the run
   destination, Run. AR needs a real phone: the simulator has no camera.
5. On the phone: hold the title on the sign-in screen and enter the server address (see below).

The `// VERIFY:` spots were checked against the iOS 26.5 SDK (Xcode 26.6) on Oct 16 2026; what can only be judged
on a phone is marked `// ON DEVICE:` (`grep -rn "ON DEVICE:" apps/ios`).

## Run in the iOS Simulator

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # if xcode-select points at Command Line Tools
cd apps/ios && xcodegen generate
xcodebuild -project RooflineMeasure.xcodeproj -scheme RooflineMeasure \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/dd build CODE_SIGNING_ALLOWED=NO
xcrun simctl boot 'iPhone 17 Pro'; open -a Simulator
xcrun simctl install booted build/dd/Build/Products/Debug-iphonesimulator/RooflineMeasure.app
xcrun simctl launch booted com.premjeetech.roofline.measure
```

Tests: `xcodebuild test` with the same destination (app tests incl. the server-parity fixture), and
`xcodebuild test -scheme RooflineCore-Package` in `Core/`.

The simulator has no camera: AR corners and Room scan are greyed out in the measure chooser with the reason, and their
screens show a "needs an iPhone" page instead of starting a session. Sign in, jobs, search, the windows list and Sheet
photo (the web app in a web view, same session) all work against `http://localhost:4500`.

**DEBUG-only launch arguments** (`RooflineMeasure/App/DebugLaunch.swift`, compiled out of Release/TestFlight) drive the
app without taps, e.g. for screenshots:

```sh
xcrun simctl launch booted com.premjeetech.roofline.measure -debugSignIn owner@summitridge.test:summit-ridge-demo \
  -debugSearch Ridgeway -debugOpenFirst -debugMeasure add -debugMethod sheet
```

`-debugServer URL`, `-debugSignIn email:password`, `-debugSearch text`, `-debugOpenFirst`, `-debugMeasurement id` (open
this measurement when the server has no `GET ?propertyId=` route), `-debugStart` (create one; prints its id),
`-debugMeasure add|again`, `-debugMethod ar|roomplan|sheet`, `-debugSettings`.

## Reaching the server from testers' phones

Tailscale Serve: on the Mac running the API, `tailscale serve --bg 4500` gives `https://<mac>.<tailnet>.ts.net`
(tailnet only, not public). Install Tailscale on each iPhone, sign in to the same tailnet, and use that https address
as the server. On the same Wi-Fi, `http://<mac-ip>:4500` also works (the app allows local-network http).
`http://localhost:4500` only works in the simulator.

The sheet-photo screen loads the web app from the same address, so the API must serve the built web app
(`WEB_DIST_DIR`, as the demo does).

## Upload to TestFlight

```sh
export DEVELOPMENT_TEAM=ABCDE12345
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
apps/ios/scripts/testflight.sh
```

It runs the Core checks, `xcodegen generate`, `xcodebuild archive` (build number = UTC timestamp `yymmddHHMM`), then
`xcodebuild -exportArchive` with `ExportOptions.plist` (method `app-store-connect`, destination `upload`), signing
and uploading with the API key. The build appears under TestFlight after Apple processes it; add it to the internal
testing group. Builds are marked internal-testing-only (`testFlightInternalTestingOnly`); drop that key from
ExportOptions.plist before a build for external testers.

## Owner prerequisites (block TestFlight, not the code)

- Apple Developer Program membership ($99/yr) and the team id.
- Xcode from the App Store on the Mac that builds.
- App Store Connect: accept the agreements, create the app record (bundle id `com.premjeetech.roofline.measure`,
  name "Roofline Measure").
- A Team API key (Users and Access > Integrations > App Store Connect API, role App Manager): Key ID, Issuer ID, and
  the `.p8` saved in `~/.appstoreconnect/private_keys/`.
- Internal testers added in App Store Connect (TestFlight > Internal Testing).
- Tailscale on the Mac and on every tester's iPhone.
- Test phones: a LiDAR iPhone (12 Pro or a later Pro) and a non-LiDAR iPhone.

## Field accuracy test

Measure the same windows with a tape and with the app (several passes each, LiDAR and non-LiDAR), then export the
CSV (hidden screen above). Compare `width_in`/`height_in` with the tape, and check that about two thirds of passes
land within their ± (it is about one standard deviation). If they do not, the per-device sigmas in
`Core/Sources/RooflineCore/ArSizing.swift` (`ArSigmaModel`) and on the server need updating together.

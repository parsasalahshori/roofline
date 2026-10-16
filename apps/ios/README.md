# Roofline Measure (iPhone)

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

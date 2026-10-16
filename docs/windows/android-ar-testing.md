# Testing AR window measuring on a real Android phone

The windows screen has an **AR (Android)** method: Chrome on an Android phone with ARCore opens a WebXR
`immersive-ar` session, a reticle sits on the wall or frame, and the person taps the four FRAME corners. The size
is the distance between the tapped 3D points, so no measuring sheet is needed.

None of this can be checked on a laptop: the automated tests use a fake `navigator.xr`. This page is how to try it
on a phone, safely, against the app already running on your Mac.

## What you need

- An Android phone that supports ARCore (most mid-range and better phones from 2019 on). The list:
  https://developers.google.com/ar/devices
- "Google Play Services for AR" installed and up to date on the phone (Play Store; it usually installs itself the
  first time an AR page asks).
- Chrome for Android, recent.
- A USB cable, and Chrome on the Mac.
- The app running on the Mac at `http://localhost:4500`.

## Why USB port forwarding (and not a tunnel or the Mac's IP)

WebXR only runs in a **secure context**: `https://`, or `http://localhost`. Opening the Mac's LAN address
(`http://192.168.x.x:4500`) on the phone is NOT a secure context, so the AR tab will never show. Chrome's USB port
forwarding makes the phone's own `localhost:4500` reach the Mac's `localhost:4500` over the cable. The phone then
treats the page as localhost (secure), with no certificates, and nothing is exposed to the network or the internet.
Do not set up public tunnels (ngrok, Cloudflare tunnels and the like) for this.

## Steps

1. **Phone: turn on USB debugging.** Settings > About phone > tap "Build number" 7 times to unlock Developer
   options. Then Settings > System > Developer options > turn on "USB debugging".
2. **Plug the phone into the Mac.** Unlock the phone and accept "Allow USB debugging?" (tick "Always allow from this
   computer").
3. **Mac: open `chrome://inspect/#devices`** in desktop Chrome. Make sure "Discover USB devices" is ticked. The phone
   appears in the list (open Chrome on the phone if it does not).
4. **Port forwarding.** Click "Port forwarding…", add a rule: port `4500` -> `localhost:4500`. Tick "Enable port
   forwarding" and press Done. Keep this `chrome://inspect` tab open while you test; forwarding stops when it closes.
5. **Phone: open Chrome at `http://localhost:4500`.** Sign in as usual, open a job's windows screen, "Add windows
   from photos".
6. **Take a photo of a window, tap Measure.** The method tabs start with **AR (Android)**. Or use "Measure with AR"
   on the photos screen to start in AR without a photo first.
7. **Start AR.** Chrome asks for camera permission (and may ask to install or update Google Play Services for AR).
   - Move the phone slowly side to side until the reticle (white ring) appears on the wall or the frame.
   - Aim at the top-left FRAME corner and tap the screen (or press Place corner). Then top right, bottom right,
     bottom left. The sides show live in inches; after four corners the size shows with its ±.
   - Undo takes back the last corner; Start over clears them.
   - Finish ends AR. If the phone grants camera access, one picture of the window is kept, with the corners drawn
     where you tapped. If not, the photo you already took is used (or you are asked to take one), and the corners
     on it are only a guide (the photo inset 15%); the size still comes from AR.
8. **Save window.** The server re-sizes the window from the four 3D points (its value wins) and marks it "check" if
   the corners are not a clean flat rectangle.

You can watch the phone's console from the Mac: on `chrome://inspect`, click "inspect" under the phone's tab.

## If the AR tab does not show

The tab shows only where `navigator.xr.isSessionSupported('immersive-ar')` says yes. Check, in that order:

1. **The address is `http://localhost:4500`** on the phone (port forwarding), not the Mac's IP. In the remote
   inspector console, `window.isSecureContext` must be `true`.
2. **WebXR is there:** in the remote console run `await navigator.xr?.isSessionSupported('immersive-ar')`.
   - `undefined`: no WebXR in this browser (not Chrome, a very old Chrome, or an in-app browser). Use Chrome.
   - `false`: the phone is not ARCore-capable, or Google Play Services for AR is missing or out of date. Update it
     from the Play Store, restart Chrome, try again.
3. **Reload** after fixing: the answer is asked once per page load.
4. On an iPhone the tab never shows (Safari has no WebXR). The photos how-to says so; use the measuring sheet.

## If AR starts but corners will not place

- **Aim at the frame, not the glass.** Glass is transparent and reflective, so AR finds no surface on it: the
  reticle disappears and Place corner stays grey.
- **Plain white walls and frames in dim light** give AR little to track. Turn on lights, open the blinds, and sweep
  the phone side to side first so AR maps the wall around the window.
- **"Move slowly to find the wall again"** means AR lost tracking (fast moves, covering the camera, very low light).
  Slow down and point at the wall; the count of these is saved with the window, and a window that lost tracking
  more than 3 times is marked "check".

## Checking accuracy (please do this before trusting the ±)

The ± assumes each tapped point wanders about 3 mm (1 sigma). That figure is an assumption, not a measurement:
ARCore publishes no accuracy number. Before relying on AR sizes for orders:

1. Pick 5 windows of different sizes. Tape-measure each frame's inside width and height.
2. Measure each twice in AR (they group into one window with a median and spread).
3. Note the AR size, the tape size, the distance you stood at, the light, and the phone model.

Send the numbers back; the per-point noise (`AR_POINT_SIGMA_M` in `packages/shared/src/window-photo-math.ts`) is
calibrated from them. Expect AR to drift on long sweeps: measure each window in one steady pass, 1 to 2 m away.

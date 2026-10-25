# Multi-frame window scan: contract (v1)

How a homeowner's window SCAN goes from the iPhone to the server and through review. Modelled on how Medida works
(see ~/RooflineWork/review/medida-teardown.md): many frames + close-ups of the corners → each corner triangulated from
≥3 frames → quality gates → a person confirms anything below the bar (junior, then senior) → Measured or Visit Required.

The existing single-photo window path (`POST .../requests/:id/windows`, `PhotoWindowInput`) is unchanged. A scan
ADDS evidence to a window the app already sent (same `windowId`); the window's size is replaced only by an accepted
scan result (auto-accepted, or confirmed by a reviewer).

## Coordinates (both sides MUST use exactly these)

- World: ARKit world space, metres, +Y up (gravity), one ARSession per scan (all frames share it).
- `cameraTransform`: 16 numbers, COLUMN-MAJOR 4x4 (simd / ARCamera.transform layout; translation = m[12], m[13], m[14]).
- `intrinsics`: `{ fx, fy, cx, cy, width, height }` in pixels of the NATIVE (landscape) camera image.
- Image points (`x`, `y`): pixels of that native landscape image, origin top-left, x right, y down.
- Projection of world point P: `c = inverse(cameraTransform) * P` (rigid inverse); visible only if `c.z < -1e-4`;
  `x = cx + fx * c.x / (-c.z)`, `y = cy - fy * c.y / (-c.z)`. (Same as RooflineCore `ImageMapping.project`.)
- Ray through image point (x, y): origin = camera translation; direction (camera space) =
  `normalize(((x - cx) / fx, -(y - cy) / fy, -1))`, rotated into world by the transform's 3x3.
- Uploaded JPEGs are the NATIVE landscape image (not rotated); `imageWidth/imageHeight` = JPEG pixel size; when it
  differs from `intrinsics.width/height`, scale image points by `imageWidth / intrinsics.width` (same for height).
- Corner order everywhere: 0 TL, 1 TR, 2 BR, 3 BL as the person faces the window (gravity-ordered).

## Triangulation (identical math in Swift and TypeScript)

For one corner with rays (o_i, d_i), i = 1..n, d_i unit: the point P minimising Σ |(I − d_i d_iᵀ)(P − o_i)|² is
`P = (Σ A_i)⁻¹ Σ A_i o_i` with `A_i = I − d_i d_iᵀ`. Require n ≥ 2 and the 3x3 well conditioned (smallest
eigenvalue of Σ A_i ≥ 1e-6 · n), else the corner is untriangulated. Reprojection error of a mark = pixel distance
between the mark and the projection of P in that frame (in native px).

Then: fit the level rectangle to the 4 triangulated corners exactly as RooflineCore `RectangleFit.fit` (plane =
least-squares plane of the 4 points facing the viewer, "up" = gravity projected into that plane, left = mean of TL/BL
s, right = mean of TR/BR s, top/bottom likewise). Width/height in inches = the rectangle's sides (`inchesPerMetre =
39.37007874`). Opening = this rectangle; Window (inner frame) = optional, same as today.

## Quality gates (codes are shared; a scan passes when none fail)

| code | fails when |
|---|---|
| `too_few_frames` | any corner has < 3 marks used for triangulation |
| `reprojection` | RMS reprojection error over all marks > 3.0 px, or any single mark > 8.0 px |
| `baseline` | the largest angle between rays of a corner < 4° (frames too close together to triangulate) |
| `sym_ratio` | opposite sides of the TRIANGULATED quad differ by > 0.75 in or > 2% |
| `plane` | any corner > 1.0 cm from the corners' least-squares plane |
| `scale` | the triangulated width/height differ from the single-frame (LiDAR/plane) estimate by > 3% |
| `no_closeups` | fewer than 2 close-up frames used (warning only: does not fail on its own) |

`status`: `measured` when no gate fails (auto-accepted), else `needs_review`.

## iPhone → server

1. Each frame's JPEG goes up through the EXISTING `POST /api/public/homeowner/:slug/requests/:id/uploads` (raw JPEG,
   bearer token) → `uploadId`. (Depth is not uploaded in v1.)
2. `POST /api/public/homeowner/:slug/requests/:id/scans` (bearer token, JSON, ≤ 1 MB), idempotent on `scanId`:

```json
{
  "scanId": "uuid",
  "windowId": "the window's id already sent with POST .../windows",
  "app": "0.1.0 (2610251200)", "device": "iPhone17,2",
  "wall": { "point": [x, y, z], "normal": [x, y, z] },
  "frames": [
    { "frameId": "f1", "kind": "regular" | "closeup", "corner": 0 | 1 | 2 | 3 | null,
      "uploadId": "…", "imageWidth": 1920, "imageHeight": 1440,
      "cameraTransform": [16 numbers], "intrinsics": { "fx": 0, "fy": 0, "cx": 0, "cy": 0, "width": 1920, "height": 1440 } }
  ],
  "marks": [ { "frameId": "f1", "corner": 0, "x": 812.5, "y": 410.0, "source": "ai" | "snap" | "projected" | "user" } ],
  "result": {
    "cornersM": [[x, y, z], [x, y, z], [x, y, z], [x, y, z]] | null,
    "widthIn": 34.625 | null, "heightIn": 55.75 | null,
    "windowFrame": { "widthIn": 33.25, "heightIn": 54.375, "estimated": true } | null,
    "quality": { "framesPerCorner": [4, 4, 3, 5], "reprojRmsPx": 1.4, "reprojMaxPx": 3.1, "minBaselineDeg": 7.5,
                 "symRatioDiff": 0.004, "planeMaxCm": 0.3, "scaleDiff": 0.01, "closeups": 4,
                 "failed": ["sym_ratio"] },
    "status": "measured" | "needs_review"
  }
}
```

Limits: 3–24 frames, ≤ 200 marks, frames' uploads must belong to this request. Server validates (zod `.strict()`),
RE-RUNS the triangulation and gates in TypeScript from frames + marks (the server's result wins; the phone's is kept
for comparison), stores the scan, and answers `{ scanId, status, result }` (the server's).

When `status = measured` the window's size becomes the scan's opening (the existing window row's width/height and
quality = 'good'). When `needs_review` the window keeps its current size and shows "Being checked by WinChoice".

## Review (staff web app)

Statuses: `processing` → `measured` (auto) | `needs_review` → `in_review` (junior) → `junior_done` → (senior)
`measured` | `visit_required`. Double review: a junior reviewer adjusts marks and submits; a senior reviewer
confirms (or adjusts) and finalises. Expedite flag moves a scan to the top and out of the regular SLA. SLA: due
`created_at + 24 h` (company setting later).

Reviewer actions use the same math: the web app re-triangulates live as marks are dragged (shared TypeScript in
`packages/shared`), shows the gates, and a scan can be finalised as `measured` only when no gate fails or the senior
overrides with a written reason. `visit_required` needs a reason.

Staff API (session auth, org-scoped, RLS like other tables):
- `GET /api/window-scans?status=…` queue (with SLA due, expedite, window/room, request, homeowner name).
- `GET /api/window-scans/:id` scan + frames (signed image URLs) + marks + server result + history.
- `PATCH /api/window-scans/:id/marks` replace marks (reviewer) → recomputed result.
- `POST /api/window-scans/:id/submit` junior submit; `POST /api/window-scans/:id/finalize` senior
  `{ outcome: 'measured' | 'visit_required', reason? }`; `POST /api/window-scans/:id/expedite`.
On `measured` the window's size is updated as above; the homeowner app sees it on its next status/view fetch.

Shared math lives in `packages/shared/src/window-scan.ts` (triangulate, rectangle fit, gates) with fixtures in
`packages/shared/test/fixtures/window-scan/*.json` that the iOS Core checks also run (parity).

## Implementation notes (server and staff web, v1)

What was decided where the contract is silent, and where the code lives:

- **Code**: math `packages/shared/src/window-scan.ts` (+ tests `packages/shared/test/window-scan.test.ts`, synthetic scenes
  `packages/shared/test/fixtures/window-scan-scene.ts`, parity fixtures `fixtures/window-scan/*.json` written by
  `generate.ts` there); table `window_scans` (migration 0046); public route `apps/api/src/public/homeowner-scans.ts`; applying a
  scan to its window `apps/api/src/estimator/window-scan-apply.ts`; staff API `apps/api/src/routes/window-scans.ts`; staff
  screens `apps/web/src/features/scans/`; demo data `scripts/seed-window-scans.ts`.
- **Marks are in the native image's pixels** (the image `intrinsics` describe). The uploaded JPEG may be a resized copy of it;
  the staff screen draws the picture stretched to the native size, so marks line up whatever the JPEG's size. (Send the
  native size to avoid any doubt.)
- **Triangulation**: one mark per (frame, corner) (the last wins); a corner needs >= 2 rays; the four corners are projected
  onto their least-squares plane before the level fit (like the Swift caller of `RectangleFit.fit`). `cornersM` in a result is
  the **fitted rectangle's** corners; `triangulatedM` (additive) is the corners before the fit. The `scale` gate uses the
  median, over the frames that mark all four corners, of the size the wall plane alone gives (rays met with the phone's
  `wall`); without a wall (or such a frame) it is not checked and passes (`scaleDiff` 0). `no_closeups` is a warning: it
  shows in the gate list but never in `quality.failed`. Numbers that cannot be worked out are 0 in `quality` (so every
  field stays a number); `cornersM`/`widthIn`/`heightIn` are null.
- **Fixtures**: compare numbers within `expected.tolerance` (0.01 in, 0.0005 m, 0.05 px).
- **A scan the window cannot take** (size outside 6 to 200 in) is not auto-accepted: it goes to review like a failing scan.
- **Statuses and roles**: `needs_review` -> `in_review` (the first mark edit; that member is the junior) -> `junior_done`
  (Submit) -> `measured` | `visit_required` (Finalise). Any member (owner, office, rep) may edit marks and submit. **Senior =
  the capability `approve_factory_order` (owner and office)**: only they finalise, and only they may move marks after the
  first review has submitted. Finalising needs the first review done (`409 needs_first_review`); the same person may do both
  steps in a one-person company. `measured` needs a size and every gate passing, or `override: true` with a written reason
  (>= 3 characters, `422 gates_failed`); `visit_required` needs a reason (`422 reason_needed`). Marks are replaced whole by
  `PATCH .../marks`; the phone's original marks are kept (`marksOriginal`). Every step is on the scan's history and the audit log.
- **Expedite** is a flag any member can set or clear on an open scan; it is out of the 24 hour SLA (`secondsLeft: null`).
- **Homeowner view**: a window with a scan carries `scan: { scanId, state, label }`; `visit_required` also marks the window
  `check` with "We will measure this one at your free visit."
- **Staff API additions**: `GET /api/window-scans?status=` takes `open` (default), `done`, `all`, one status, or several
  separated by commas, and answers `{ scans, counts }` (each scan has a `thumbUrl`); `GET /:id/frames/:frameId/image` serves a
  frame's picture (the request's upload, behind the session, like window photos).

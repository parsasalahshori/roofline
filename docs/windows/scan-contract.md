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

## Refinement (server, after every scan upload)

Medida rebuilds the scene in 3D from the photos with COLMAP and runs a segmentation mask on every frame. The server does both as a
REFINEMENT that runs after the phone's scan is stored. Nothing changes on the phone: the contract above is unchanged, every new
field is additive, and the phone's own result (and the server's first result) stays available to compare.

Switched on with `SCAN_REFINE=on` (default off) and useful only with an AI model (`WINDOW_SEGMENTER=sam2`, models in
`WINDOW_MODEL_DIR`/`SAM_MODEL_DIR`) and/or COLMAP (`SCAN_COLMAP_PYTHON` = a python with pycolmap, numpy and pillow; optional
`SCAN_COLMAP_SCRIPT`, `SCAN_COLMAP_TIMEOUT_S`, default 900). With neither on the machine a scan is accepted or sent to review at once, as before.

### Flow

1. `POST .../scans` stores the scan as `processing` (the homeowner still reads "Being checked by WinChoice"; the window keeps its
   size) and answers the phone with the FIRST server result (`status: 'processing'`, `result` = the triangulation of the phone's
   marks). It queues the pg-boss job `scan-refine` (`{ companyId, scanRowId }`, one waiting per scan). If the queue is not
   reachable the scan falls back at once to what the first result says.
2. The job (apps/api/src/scans/refine/run.ts) runs, side by side: **the AI on every frame** and **COLMAP** (below).
3. It merges, triangulates again and works out the result with the unchanged level fit and seven gates. A scan that was
   `processing` is then `measured` (every gate passes and the size is one a window can have: the window takes it) or
   `needs_review`. A scan a person is already working on (`needs_review`, `in_review`, `junior_done`; a reviewer pressed
   "Re-run refinement") keeps its status. `server_result` is the refined result from then on (the effective one): the first
   one is kept in `refinement.firstResult`.
4. A refinement that cannot be done never strands a scan: it records why (`refinement.state = 'failed'`) and a `processing`
   scan takes the decision the first result gave. Only a database error is retried (pg-boss, 5 attempts).

### The AI on every frame (SAM 2)

For each frame the current triangulated window rectangle (`server_result.cornersM`) is projected into it with that frame's pose
(`scanProject`), the bounding box is padded 8% and sent to SAM 2 as the box, with the box's centre as a positive point. OWLv2
is asked for a box only where there is no estimate yet. The mask is fitted with the window quad (`providers/window-quad.ts`);
a believable quad (fit quality >= 0.6) becomes four marks with source `ai`, put in the scan's corner order (the picture is the
native landscape image, so a phone held upright shows the window on its side: the quad's corners are matched to the projected
window, or to gravity when there is none). The mask goes to the object store as a small tinted PNG (at most 640 px wide) at
`<companyId>/window-scans/<scan>/masks/<frameId>.png`; a close-up of a corner usually has a mask and no quad (the window runs
off the picture), which is recorded as `no_quad`.

Per corner and frame the marks are combined: a reviewer's mark (source `user`) stands alone; an AI mark within 8 px of the
phone's replaces it; further off, both stay as candidates and the robust triangulation chooses.

### COLMAP (apps/worker/python/colmap_refine.py)

SIFT features and exhaustive matching on the frames' JPEGs, then incremental mapping, with every camera's intrinsics KNOWN and
held fixed: a PINHOLE camera from `fx, fy, cx, cy` multiplied by `imageWidth / intrinsics.width` (and the same for height),
because the JPEG may be a resized copy of the native image the intrinsics describe.

Conventions: an ARKit camera looks along -z with +y up; a COLMAP camera looks along +z with +y DOWN. With
`D = diag(1, -1, -1)`: `cam_from_world(COLMAP) = D * inverse(cameraTransform)` and `cameraTransform = inverse(cam_from_world) * D`
(the self-test in the script and the synthetic scene check both). COLMAP's model is unscaled and in its own frame: a similarity
transform (Umeyama on the camera centres; when the centres lie on a line the rotation comes from the camera orientations)
puts it in ARKit's world, in metres. The alignment's RMS over the camera centres is reported.

The refined poses (COLMAP's, transformed) replace ARKit's when **at least 4 frames are registered and the alignment RMS is under
2 cm** (and the cameras' orientation RMS is under 2 degrees: a turn round a line of camera centres is invisible in the centres).
A frame COLMAP put more than 5 cm or 5 degrees from the phone's keeps ARKit's pose. If COLMAP's poses fit the marks worse than
ARKit's (more gates fail), ARKit's are kept. Otherwise ARKit's poses stay, and the reason is on the scan. The aligned sparse
points are kept as an ascii PLY (`.../cloud.ply`).

### Robust triangulation

Each corner is triangulated from ALL its candidate marks: a pair of candidates from two frames makes a hypothesis, the point most
frames agree with (within 4 px) wins, the corner is met again from the frames that agree, and a mark landing more than 8 px from it
is thrown out while at least 3 marks remain. A reviewer's own marks are never thrown out. Then the level rectangle and the seven
gates run exactly as above (`computeRefinedScan` in `packages/shared/src/window-scan-refine.ts`).

### What is stored and shown

- `window_scans.refinement` (migration 0049, `ScanRefinementRecord`): `state` (`queued | running | done | failed`), `trigger`
  (`upload | rerun`), times, `firstResult`, `poseSource` (`arkit | colmap`) and `poseNote`, `poses` (the refined camera
  transforms by frame id), `colmap` (registered/total, alignment RMS cm, scale, method, points, timings, reason), per-frame AI
  (`frames`: state, fit quality, SAM score, prompt box, mask key, ms), `aiMarks`, `alternatives` (candidates that lost),
  `dropped` (marks thrown out), the cloud key and `timings`.
- `server_result.refined` (additive on `ScanResult`): pose source, frames on COLMAP poses, alignment RMS, AI frames and marks,
  marks used and dropped, and the size before refinement.
- `marks` become the marks the refined result is worked out from (one per frame and corner); `marksOriginal` stays the phone's.
  The staff screen's live triangulation and `PATCH .../marks` use the refined poses (`frames[].cameraTransform` in the detail is
  the effective one, `frames[].poseSource` says where it is from), so what the reviewer sees is what the server computes.

Staff API additions: `GET /api/window-scans/:id` carries `refinement` (`ScanRefineView`), `mayRefine` and per frame `poseSource`
and `ai` (with `maskUrl`); `POST /api/window-scans/:id/refine` runs it again on an open scan (409 `already_running`,
409 `scan_closed`, 503 `refine_unavailable`; a reviewer's marks are kept); `GET /:id/frames/:frameId/mask` (PNG);
`GET /:id/refinement/cloud` (`{ count, points: [[x, y, z, r, g, b]] }`, thinned for the screen) and `/cloud.ply` (the file).
Statuses and history: `processing` shows in the counts and not in the review queue until the job is done; history gains
`refined` (with a one-line summary) and `refine_failed`.

### Limits worth knowing

- The AI is prompted from the first result: if the phone's marks were far off, the first rectangle (and the box) is too, and the
  AI may find nothing; a re-run starts from the refined rectangle.
- A mask quad is a noisier corner than a phone's snapped mark; an AI mark that agrees (8 px) replaces the phone's, as asked.
- Metric scale comes from ARKit's camera centres (COLMAP has none of its own): a scale drift in the phone's tracking carries over.
- Close-ups give masks and no quad; planar scenes with little texture may not register in COLMAP (then ARKit's poses are kept).

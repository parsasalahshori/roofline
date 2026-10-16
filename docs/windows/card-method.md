# Card method: a window's size from a credit card on the glass

- Quote-grade only, never order-grade. One photo, one ID-1 card, eight taps (the card's four corners, the window frame's four).
- Built and measured on SYNTHETIC photos. There is no field data yet, so real errors will be larger than the numbers below until the
  field test (`docs/windows/android-ar-testing.md` describes the habit: tape-measure real windows, log the tape size next to the app's).
- Code: `packages/shared/src/window-photo-card.ts` (`sizeFromCard`, `cardProblem`). Every number here: `npx tsx scripts/window-card-accuracy.ts`.

## Main finding

- For windows much bigger than the card, the card method is 'check' (quote-grade). Under the assumptions below the median claimed ±
  crosses 3/8 in at a window about 16 x 24 in (longest side 24 in, size ratio 7) in the typical shot; 17 x 25 square on, 15 x 23 at 1.0 m.
  At 40° or from 2.5 m even a small window stays over 3/8 in. Every window from 24 x 36 up is 'check' in every shot tested.
- A 36 x 60 window comes out ± 0.9 in, a 72 x 80 about ± 1.4 in: roughly 1.5% of the window's longest side. The limit is the card: its
  four taps fix the scale, and 2 px of tap noise on a card about 160 px long is the largest part of the ± (58 to 68% of its variance).
- Halving the tap noise to 1 px only brings a 48 x 72 from ± 1.12 to ± 0.79 in. Bigger windows need a bigger reference or AR; this study
  did not compare them.

## What it does

- The homeowner holds or tapes a credit, debit or driver licence card (all ID-1, 85.60 x 53.98 mm) flat on the glass and takes one photo.
- They tap the TIP of each rounded corner of the card (any corner first, either way round) and the four corners of the window frame.
- It returns width and height in inches (unrounded), a ± (about 1 sigma), `quality`, plain-word `reasons` when 'check', the distance
  to the glass, the angle off square, and the size ratio (window's longest side over the card's long side).
- 'check' when: the larger ± is above 3/8 in; the view is steeper than 50°; the card is small in the photo (long side under 1.5% of the
  photo's long side); the marked card does not look like a card lying flat on the glass; the lens is a wide one (under 20 mm-equivalent);
  or the window is tiny in the photo. `cardProblem` gives the plain reason for a 422 (corners that cross or are not a four-cornered
  shape, a card that is too small, bigger than the window or not ID-1, points outside the photo).

## How it works

- Tilt from the window. Its four corners are a rectangle seen in perspective, which gives the wall's angle to the camera for a known
  focal length (the maths of `rectangleAspect`).
- Scale from the card. Its taps are put on that plane; the best-fit rectangle of the card's real size gives the distance to the glass.
- The frame is about 1 in in front of the glass, so its corners go on a plane 1 in nearer the camera (exact for oblique views).
  Width = mean of the top and bottom edges, height = mean of the left and right edges, as in the sheet method.
- Why not a homography from the card alone? A card 150 px wide cannot fix the tilt: tap noise becomes a perspective error that grows
  across a window 20 times as wide. Same assumptions, median error: 3.1 in on 24 x 36 and 32.6 in on 48 x 72, against 0.37 and 0.75 in here.
- The taps sit on the tips of the rounded corners, 0.93 mm inside the true corners ((1 - 1/sqrt 2) x 3.18 mm): the metric rectangle is
  83.74 x 52.12 mm.
- The ±: first-order propagation (central differences) of the 16 taps, the focal length, the frame offset, the card rectangle and a 0.1%
  floor, added in quadrature, times 1.05 (`CARD_SIGMA_SCALE`, fitted so that 68% of errors fall inside it).
- For the server: `cardProblem` first, then `sizeFromCard` with `focalPx` from the photo's 35 mm value. If the photo has none and 26 mm
  was assumed, pass `focalSigmaFrac: SHEET_FOCAL_UNKNOWN_SIGMA` (10%, else 3%). Leave `tapSigmaPx` alone unless the field test gives a figure.

## Assumptions (every number here depends on them)

- A pinhole camera with no lens distortion, a flat rectangular window, an ID-1 card lying flat on the glass and tapped at the tips, the
  photo as displayed (EXIF orientation applied) with its principal point at the centre.
- The numbers (tap noise, frame offset, focal length) are listed under the tables. The biggest is the tap noise: 2 px per coordinate.

## What helps (for the app's coaching)

- Use a real ID-1 card from any wallet: credit, debit or driver licence. Not a gift card or business card that is not 85.6 x 53.98 mm.
- Tape the card flat on the glass in the middle of the window, fully visible, no glare. 10° off flat costs 0.2 to 0.3 in on 48 x 72;
  30° costs 1.5 to 2.2 in.
- Tap the TIP of each rounded corner, using the magnifier. Tapping where the sharp corners would be makes the window about 2.6% too small.
- Stand square to the window, 3 to 5 ft (1 to 1.5 m) back, with the whole window in the photo and some room around it. Closer does not
  help (the frame's depth matters more up close); farther makes the card small.
- Use the main (1x) camera, not the wide one. Hold still. Tap the four inside corners of the frame: top left, then clockwise.

## Accuracy (synthetic photos)

"Claimed ±" is what the server returns (68% of errors inside it, 95% inside twice it). "Real error" is the larger of the width and height errors.

### Typical shot: yaw 15°, camera 1.5 m from the glass (farther back when the window would not fit), 4000 trials per row

| Window (in) | Camera (m) | Size ratio | Claimed ± (in), median | Real error (in), median | Real error (in), 95th pct | Flagged 'check' |
| --- | --- | --- | --- | --- | --- | --- |
| 12 x 18 | 1.50 | 5.3 | 0.28 | 0.20 | 0.54 | 0% |
| 18 x 24 | 1.50 | 6.9 | 0.37 | 0.26 | 0.73 | 17% |
| 24 x 36 | 1.50 | 10.6 | 0.55 | 0.37 | 1.10 | 100% |
| 36 x 48 | 1.50 | 14.4 | 0.73 | 0.49 | 1.44 | 100% |
| 36 x 60 | 1.50 | 18.0 | 0.91 | 0.62 | 1.77 | 100% |
| 48 x 72 | 1.69 | 21.3 | 1.13 | 0.75 | 2.17 | 100% |
| 60 x 72 | 1.83 | 21.5 | 1.17 | 0.79 | 2.29 | 100% |
| 72 x 80 | 2.19 | 23.8 | 1.44 | 0.99 | 2.84 | 100% |

Other shots. Each cell: claimed ± / real median / real 95th pct (in), share flagged 'check', camera distance (m).

| Window (in) | square on (0°, 1.5 m) | angled (40°, 1.5 m) | close (15°, 1.0 m) | far (15°, 2.5 m) |
| --- | --- | --- | --- | --- |
| 24 x 36 | 0.53 / 0.36 / 1.04, 100% (1.50) | 0.71 / 0.53 / 1.34, 100% (1.50) | 0.59 / 0.41 / 1.14, 100% (1.00) | 0.73 / 0.49 / 1.36, 100% (2.50) |
| 36 x 48 | 0.71 / 0.49 / 1.38, 100% (1.50) | 0.89 / 0.72 / 1.78, 100% (1.50) | 0.74 / 0.51 / 1.44, 100% (1.15) | 0.96 / 0.63 / 1.82, 100% (2.50) |
| 36 x 60 | 0.88 / 0.60 / 1.75, 100% (1.50) | 1.12 / 0.84 / 2.21, 100% (1.56) | 0.90 / 0.60 / 1.77, 100% (1.40) | 1.20 / 0.81 / 2.36, 100% (2.50) |
| 48 x 72 | 1.07 / 0.73 / 2.15, 100% (1.53) | 1.48 / 1.11 / 2.76, 100% (1.90) | 1.13 / 0.76 / 2.18, 100% (1.71) | 1.44 / 0.97 / 2.77, 100% (2.50) |
| 60 x 72 | 1.10 / 0.74 / 2.15, 100% (1.69) | 1.52 / 1.22 / 2.99, 100% (2.02) | 1.16 / 0.78 / 2.21, 100% (1.81) | 1.44 / 0.98 / 2.78, 100% (2.50) |
| 72 x 80 | 1.34 / 0.91 / 2.62, 100% (2.02) | 1.80 / 1.46 / 3.57, 100% (2.27) | 1.43 / 0.98 / 2.75, 100% (2.16) | 1.60 / 1.11 / 3.05, 100% (2.50) |

Assumptions behind both tables:
- Tap noise 2.0 px per coordinate (0.05% of the long side) on the card and the window corners. This is the biggest assumption.
- Frame offset: told 1 in; truth drawn each trial from a normal, mean 1 in, sigma 0.5 in. Focal length: told 26 mm-equivalent; truth sigma 3%.
- Card: the tapped rectangle is the card inset by its rounded corners (83.74 x 52.12 mm), each side sigma 0.5 mm; in the middle of the
  window, landscape or portrait, turned up to 10°, tapped from a random corner in a random direction.
- 12 MP photo, 3024 x 4032 (these windows are taller than wide), 26 mm-equivalent, no lens distortion, pitch 0. 4000 trials, seed 20261016.
- SYNTHETIC photos, not field data. Real error will be larger until the field test (`docs/windows/android-ar-testing.md`).

If the taps are sloppier (typical shot, claimed ± / real median, in):

| Tap noise per coordinate | 24 x 36 | 48 x 72 |
| --- | --- | --- |
| 1 px | 0.41 / 0.28 | 0.79 / 0.55 |
| 2.0 px (assumed) | 0.55 / 0.38 | 1.12 / 0.74 |
| 4 px | 0.90 / 0.61 | 1.94 / 1.29 |
| 8 px | 1.67 / 1.14 | 3.70 / 2.39 |

Calibration: 69% of the errors fall inside 1 sigma (rows between 67% and 71%) and 96% inside 2 sigma, on a seed other than the one
`CARD_SIGMA_SCALE` was fitted on. Slightly conservative on purpose.

## Known limits

- When the photo breaks an assumption (width / height error in inches, noise-free, 48 x 72, typical shot; the ± there is 0.76 and 1.13):
  card tilted 10° +0.18 / +0.27, 30° +1.46 / +2.19; lens bending the picture 1% at its edge +0.44 / +0.62, 2% +0.87 / +1.23;
  frame 2 in in front instead of 1 +0.77 / +1.16, level with the glass -0.75 / -1.12; taps on the sharp corners instead of the tips
  -1.24 / -1.86; focal length 10% off -0.15 / +0.20 (more when off square).
- No real phone lens has been measured. The wide lens is flagged 'check'; the main lens is assumed close to a pinhole.
- A photo with no focal length is sized at 26 mm: pass the 10% doubt, and expect a larger ± at angles.
- The window must be a rectangle in one plane: arched, bay, bowed or very deep-set windows are not covered.
- Real taps may well be sloppier than 2 px: unaided, one screen point of a 4032 px photo shown about 400 points wide is about 10 photo
  px (a guess, not a measurement). The magnifier is what is meant to hold 2 px.

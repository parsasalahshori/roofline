# Roof area against EagleView: where the error comes from (rounds 3 and 4, area track)

Branch `roof3/area`. Round 3 measured the causes and built the rules with the outline moved; round 4 (below) prices
them instead, on the orchestrator's ruling: **the rim and the roof under overhangs change the priced area only; pieces
that are not roof are geometry.**

## Round 4: priced, not drawn

| error | how it is handled | where |
| --- | --- | --- |
| the mask's rim along eaves and rakes (+0.12 m mean) | taken off each face's sloped area along its eave and rake lines on the outline: line plan length x rim width x the face's slope factor (`eaveRimSqFt`) | `rimAlong` in area.ts, `area.eaveApply` 'priced' (default; 'outline' moves the edges as round 3 did) |
| roof under an upper overhang (stack, -3.1 % mean) | added to the lower face's sloped area along each wall line: plan length x `tuckUnderM` 0.3 x slope factor (`underOverhangSqFt`) | `tuckUnder`, default 0.3 |
| decks and terraces | cut from the mask before the outline, faces rebuilt: geometry | covers.ts, `covers.enabled` (off) |

`planAreaSqFt` stays the drawn area (the faces tile the outline); `slopedAreaSqFt` is the priced area (what the scorer,
the estimate and the app sum). Drawn sloped area = `slopedAreaSqFt - underOverhangSqFt + eaveRimSqFt`. The benchmark
compares lidar truth with the drawn area (lidar sees from above: no roof under an overhang, the same rim); EagleView
with the priced. `roofModelFrom3d` multiplies a manual pitch by the priced plan area (`pricedPlanSqFt`).

**The rim, per edge.** The rim width of each outline edge is measured where it can be: the photo's colour change across
the edge (`roofEndInPhoto`), less `eavePhotoOffsetM` 0.06 (the first colour change is the inner side of the eave trim,
a light fascia or a dark gutter, which a measurer counts as roof). Where the photo reads no edge, the source's
calibration constant: `GOOGLE_EAVE_RIM_M` 0.17, set in the server wrapper (engine default 0, as `GOOGLE_PITCH_OFFSET_X12`).
No rim where the heights show no eave (a crown over it, a wall beside it). Measured on 287 dev edges with the sharpen
track's refined registration (`work-r3-area/rimcal.py`):

| edge read as | EagleView's edge inside ours, mean | rim taken | after |
| --- | --- | --- | --- |
| photo | 0.112 m | 0.176 m before the offset | -0.064 m (the offset's measurement) |
| photo silent: calibration | 0.166 m (median 0.180) | 0.17 m | +0.00 m |
| no eave in the heights | -0.012 m | 0 | -0.012 m |

What does NOT locate the eave, measured again with the refined registration: the heights. The knee where the surface
leaves its plane by 0.15 m has the right mean (0.155 m in, EagleView 0.10) but corr -0.01 with EagleView edge by edge
and a residual spread of 0.54 m (worse than leaving the edge: 0.25); at house level it anti-correlates (-0.55). Half-drop:
corr +0.07. Eaves level round a storey (the plane's height at EagleView's eaves): spread 0.1-0.6 m, no better than at
ours. An edge whose roof colour runs on past it is not thereby tight (`eaveHeldByPhoto`, off: 10/18 within 5 %).

**Decks and terraces** (covers.ts). A near-flat piece (under 2.5/12, adjoining near-flat faces at one height judged as
one) is a deck when a quarter of its edge is the outline, the roof beyond its house side (0.6-1.5 m away) stands a
storey (2 m) above it along 60 % of it and is continuous with it along no more than 15 %, and things stand on it
(0.3 m or more above its plane on 5 % of it, read 1 m away from the house: a wall's heights smear over the first metre).
On all 84 houses it fires on one, ev-47738131's lake terrace. The wall test alone also takes a one-storey tile wing, a
lower shingle section and a white patio cover (irvine-123-briar, kc-brookside, irvine-99-briar): the "things standing"
test is what keeps them, and it is too weak to call the small deck of ev-52191672 (0.04). What the cut leaves hanging on
a neck under 1 m goes with it, and the planes' pixels are masked by the cut roof before the faces are rebuilt (else
the faces came back outside the outline with duplicate lines). Pergolas (`covers.pergola`, off): scattered see-through
heights under a flat piece; Google's heights do not see through a real lattice (tr-portland-354678699: 0 % see-through),
so it calls nothing real. Lattice and patio covers at eave height are not separable from above: EagleView counts two on
ev-52191985 (a white ribbed one and a translucent one) and not the white one on ev-51881663, all smooth and continuous
with the roof.

**Results** (scorer and `panel.py`; dev tuned, held-out looked at once; every line metric unchanged: dev MED/MEAN/POOL
18.0/23.5/18.3, evidence on 15.4/21.8/18.5, held-out 20.2/29.6/27.3 and 17.9/27.5/25.6):

| | area mean | median | within 5 % |
| --- | --- | --- | --- |
| dev, base | 4.8 % | 3.9 % | 10/18 |
| dev, round 4 defaults | **3.9 %** | 4.1 % | **14/18** |
| dev, base, evidence on | 5.2 % | 4.9 % | 9/18 |
| dev, round 4, evidence on | **4.3 %** | **3.9 %** | 12/18 |
| held-out, base | 8.9 % | 2.6 % | 9/14 |
| held-out, round 4 | **8.4 %** | **2.4 %** | 9/14 |
| held-out, base, evidence on | 9.2 % | 3.5 % | 9/14 |
| held-out, round 4, evidence on | **8.7 %** | **2.6 %** | 9/14 |
| (dev, the constant alone, no photo) | 3.9 % | 3.6 % | 13/18 |
| (held-out, the constant alone) | 9.2 % | 3.7 % | 8/14 |
| (dev, with the deck cut) | 4.1 % | 4.1 % | 13/18 |
| (dev, round 3's outline trim) | | 4.2 % | 12/18 |

The deck cut fires on no held-out EagleView house. On dev it takes ev-47738131 from +4.8 to -8 % (its pitch reads 8 %
low face against face, which the terrace hid), and from +7.9 to -3.5 % with evidence on: geometry right, number worse
until the pitch is; off by default.

The held-out mean is two houses: ev-52191132 -56 % (a wing under trees, see "Under-coverage") and ev-47747994 -22 % (no
crown, no cut, no flag: nothing seen from above says what is missing).

**Gates** (`bench-r4-*.txt` in work-r3-area): every outline, IoU and lidar gate passes (the outline does not move, and
lidar is compared with the drawn area). Two kinds fail: runtime p95 in a few cohorts, and held-out truth-lidar median
area error 3.22 -> 3.77. Runtime: the same code with the rules off passes in the same hour, its calibration read 34 ms
against 22 ms in the failing run; per house the rules cost +4 % median, +12 % p95 (the photo read along each edge). The
truth-lidar cohort is 7 held-out houses: 6 improve or hold, and its median is set by ev-50264667 (-3.3 -> -3.8 %), a
house whose outline is already short where a crown bites it.

## Under-coverage, round 4 (label-free, all 84 houses)

Against Google's own numbers no house is under: drawn plan median +9.2 % over Google's whole-roof ground area, none
under by more than 8 %. Google's segments and whole-roof area are cut by the same crowns as the mask. Our own mask part
left out of the outline is neighbours cut at Google's box (four joined-buildings cuts: tr-seattle-222155638,
tr-charlotte-859480387, ev-51881964, tr-hot-springs-1549200551) and patios at ground level (the ground cut:
ev-50264843 377 sq ft, correct against EagleView); nothing else over 4 %. The mask-part choice, narrow links and the
height cut drop nothing. What does drop roof is crowns over it: four held-out houses carry `roof-hidden`
(ev-50264667, ev-52191132, ev-49611661, ev-51881844), and in each the outline stops where a crown starts while
Google's building box (not drawn from the mask) runs on under it. `ROOF3D_HIDDEN_EDGE=planes` changes 9 of 84 houses by
1.6 % at most and none of these.

## The split (the evidence)

`~/RooflineWork/roof-bench/better/work-r3-area/areasplit.py RUN --split dev` prints, per house,

    total = plan x tuck x stack x pitch x key

- **plan**: our outline's plan area against the union of EagleView's face rings (EagleView shifted by the frozen
  per-house translation), split into what we count and it does not (`+blob`: pieces wider than 1.2 m: decks, patio
  covers, a gazebo), what it has and we do not (`-blob`: a corner under a crown), and the thin rest along the edges
  (`+rim`, `-rim`), whose net over the perimeter is the outline's mean offset in metres (`bias`).
- **stack**: EagleView prices roof its rings' union does not show. Its rings carry no holes (never sum them); the plan
  area it prices is each face's sloped area over its pitch's slope factor. The difference is the lower roof running on
  under the upper roof's overhang: strips along every wall line, median width 0.29 m (209 strips on dev, quartiles
  0.22 / 0.36), 0 to 8.5 % of a house. A view from above cannot see it.
- **tuck**: what we add for that (0 with the rule off).
- **pitch**: our slope factor against EagleView's where both have roof, face against face.

Base, dev (18 houses): plan is over on 17, median +6.2 %; the outline lies **0.12 m outside** EagleView's at the mean
(-0.12 to +0.33; held-out +0.07). Stack is -3.1 % at the mean. On two-storey houses the two cancel, which is why the
total looked better than its parts; one-storey houses show the whole rim (+8 to +14 %).

Houses over 5 % in the base, and why:

| house | total | cause |
| --- | --- | --- |
| ev-51881820 | +14.0 | outline 0.33 m fat (the photo shows a bright band of sunlit wall inside the mask on two sides); pitch read 6.5 for 6 (+2.6) |
| ev-52191672 | +11.0 | outline 0.23 m fat (+7.8); a raised deck counted as roof (+6.9) |
| ev-50319630 | +8.1 | outline 0.30 m fat (+7.5), same bright band |
| ev-50264843 | +6.7 | outline 0.18 m fat (+4.7); photo too dark to show it |
| ev-53863159 | -6.6 | a corner under a tree crown missing (-3.6); roof under overhangs (-3.8) |
| ev-51882178 | -5.4 | roof under overhangs: -8.5, strips all round the upper storey |
| ev-51881663 | +5.3 | a lattice patio cover counted (+8.7); the outline itself is 0.12 m inside EagleView's |

What does NOT locate the eave: the heights. Across each outline edge the height map is half-way down its fall 0.23 m
OUTSIDE our edge on average (0.36 m outside EagleView's): Google's surface is fat (foreground fattening), and neither
the half-way point nor the point where the heights leave the face's plane correlates with EagleView's offset
(r < 0.1 over 181 edges).

## The parameters (`area.ts`, `covers.ts`; defaults as of round 4)

| parameter | default | what it does |
| --- | --- | --- |
| `area.eaveApply` | 'priced' | 'priced': the rim comes off the faces' priced area along eaves and rakes (`rimAlong`), nothing is moved. 'outline': the edges move in (round 3: `trimRoof`, or `trimOutline` with `eaveBeforeTopology`). |
| `area.eavePhoto` | true | Across each outline edge of 2 m or more the roof's own colour is learned from a strip 0.8 to 1.6 m inside; going outwards, the half-way point of the first colour change is the roof's end (a change deeper than `eaveMaxInM` 0.5 m, or already there at the strip, is no evidence). The server gives the photo when this is on. |
| `area.eavePhotoOffsetM` | 0.06 | The photo's rim is this much less than its colour change (the eave trim is roof). Measured on dev edges. |
| `area.eaveInsetM` | 0 (server: `GOOGLE_EAVE_RIM_M` 0.17) | The rim of an edge the photo reads nothing on (and short edges, and every edge without a photo): the source's calibration. |
| `area.eaveDropM` / `eaveDropShare` | 0.5 / 0.5 | No rim where the heights do not fall by this much across the edge along this share of it (a crown over it, a wall beside it). |
| `area.eaveHeldByPhoto` | false | An edge whose roof colour runs on past it takes no rim. Measured worse (10/18 within 5 %). |
| `area.eaveMinInM` | 0 | Photo readings shallower than this are not used. |
| `area.eaveBeforeTopology` | false | With 'outline': trim the squared outline before the topology instead of the finished roof. |
| `area.tuckUnderM` | 0.3 | Each flashing and step-flashing line adds its plan length times this, at the lower face's slope, to its priced area (`underOverhangSqFt`; not to a face under the smallest face size). 0.3 = EagleView's median strip. |
| `covers.enabled` | false | Decks and terraces cut from the mask before the outline (see above). |
| `covers.pergola` | false | Pergolas too (see-through heights, scattered). |

Round 3's setting, for comparison: `ROOF3D_TUNING='{"area":{"eaveApply":"outline","eaveInsetM":0.1}}'` with the
photo on (its numbers below were measured with the under-overhang added to the plan area).

## Round 3: what the outline trim measured (scorer; base -> recommended)

| | area median | within 5 % | area mean | plan median | outline offset, mean | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- |
| dev (18) | 3.9 -> 4.2 % | 10 -> 12 | 4.8 -> 4.1 % | 6.2 -> 3.6 % | +0.12 -> +0.04 m | 18.0 -> 18.4 |
| held-out (14), looked at once | 2.3 -> 1.4 % | 9 -> 9 | 8.9 -> 8.3 % | 5.3 -> 1.9 % | +0.07 -> +0.01 m | 20.2 -> 20.7 |

The line totals lose about 1 % with the outline (every hip and valley ends on a corner that moved in), and they were
already short: that is the whole of the OBJECTIVE's rise; no face count changes, and the per-line table does not get
worse. Neither rule works alone: the trim alone leaves held-out under (2.3 -> 3.0 %), the tuck alone leaves dev over
(3.9 -> 5.7 %).

## Round 3: the gates with the outline moved

With the recommended setting the benchmark fails its lidar gates (median outline IoU against the lidar outline, median
sloped-area error against it) and, by less, the hidden-edge shares. Two of those checks cannot pass a correct change:

- **Lidar outline IoU, limit 0.005.** A 0.005 drop is about 2 cm of uniform edge movement on a house. The lidar
  truth's own `expectedEdgeErrorM` is 0.22 to 0.47 m, its outline is grown by half the point spacing (0.12 m), and on
  the six dev houses that have both keys it lies +0.07 m outside EagleView's at the mean (-0.06 to +0.15), as far out
  as our base outline (+0.08 on those six). It cannot say where an eave is to better than a decimetre. Proposed: gate
  the lidar outline on its hidden-edge sets (what it was built for) and on IoU drops larger than its own edge error
  allows (0.02), not 0.005.
- **Lidar sloped-area error.** The lidar sees a roof from above too: the roof under an overhang is not in its area.
  Any tuck raises this error by construction. Proposed: compare the lidar's area with ours less `underOverhangSqFt`.

## Under-coverage, round 3 (lidar)

Against Google's own numbers nothing is under: `wholeRoofStats` is the sum of Google's segments, cut by the same tree
crowns as the mask (ours is +9 % at the median over the 84 houses, never more than 8 % under). The lidar truth (dev
houses only, 26) does show the class: our plan is under on 18, by more than 8 % on 10 (worst -38 %). The pictures of
the worst seven: on six, tree crowns stand over part of the roof and the mask (and so the outline) is bitten there, or
a wing is wholly under them (lr-305-ridgeway); on one (fs-hendricks) the lidar joins a carport Google's mask does not
have. The mask-part choice, the ground cut and the squaring drop nothing on these houses. The existing switches do
not recover it (`ROOF3D_HIDDEN_EDGE=planes` and `photo+planes`: 10 houses under before and after, median -4.8 ->
-4.3 %): they decline under a dense crown by design, and what does recover it is lidar fusion (off by owner decision).

## Not built (no general rule on this evidence)

Things counted that are not roof are different on every house: two raised decks or terraces a storey below the eaves,
one lattice cover at eave height, one pergola, one gazebo joined to the mask by a corner, one patio cover roofed like
the house (nothing tells it from roof). A low flat face EagleView does count (a white porch roof at eave height,
ev-52191985) has the same heights and the same colour contrast as the lattice cover it does not (ev-51881663): size,
height under the eaves, height roughness and colour do not separate the two groups on 19 such faces
(`work-r3-area/lowfaces.py`).

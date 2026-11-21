# Roof area against EagleView: where the error comes from (round 3, area track)

Branch `roof3/area` from `roof2/integration`. Result: **the causes are measured house by house; two rules are built
and switchable (`area.*`), both OFF by default.** Together they bring the sloped area nearer EagleView's on dev and on
held-out, but they move the outline, and the lidar gates do not let the outline move. That is the orchestrator's call
(see "The gates"). With the defaults the reconstruction is byte for byte the base's.

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

## The rules (`packages/shared/src/roof-reconstruct/area.ts`)

| parameter | default | what it does |
| --- | --- | --- |
| `area.eavePhoto` | false | Across each outline edge of 2 m or more the roof's own colour is learned from a strip 0.8 to 1.6 m inside; going outwards, the half-way point of the first colour change is the eave. The edge moves in to it (never out; a change deeper than `eaveMaxInM` 0.5 m, or already there at the strip, is no evidence). |
| `area.eaveInsetM` | 0 | An edge the photo is silent on (and short edges, and every edge when there is no photo) moves in by this. 0.1 is Google's mean excess on dev. |
| `area.eaveDropM` / `eaveDropShare` | 0.5 / 0.5 | An edge moves only where the heights fall by this much across it along this share of it: under a crown or against a wall the mask's edge is not a smeared eave. |
| `area.eaveMinInM` | 0 | Photo moves shallower than this are not made (0.2 keeps only clear bands). |
| `area.eaveBeforeTopology` | false | false: the trim is applied to the finished roof (corners and line ends on the outline move with it, no face or line is made or lost, an edge whose move would leave a face a sliver stays). true: on the squared outline, before the topology. |
| `area.tuckUnderM` | 0 | Each flashing and step-flashing line adds its plan length times this to the lower face (`underOverhangSqFt` on the face; not to a face under the smallest face size). 0.3 = EagleView's median strip. |

Recommended together: `ROOF3D_TUNING='{"area":{"eavePhoto":true,"eaveInsetM":0.1,"tuckUnderM":0.3}}'`. The server
gives the photo to the reconstruction only when `eavePhoto` is on.

## What it measures (scorer; base -> recommended)

| | area median | within 5 % | area mean | plan median | outline offset, mean | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- |
| dev (18) | 3.9 -> 4.2 % | 10 -> 12 | 4.8 -> 4.1 % | 6.2 -> 3.6 % | +0.12 -> +0.04 m | 18.0 -> 18.4 |
| held-out (14), looked at once | 2.3 -> 1.4 % | 9 -> 9 | 8.9 -> 8.3 % | 5.3 -> 1.9 % | +0.07 -> +0.01 m | 20.2 -> 20.7 |

The line totals lose about 1 % with the outline (every hip and valley ends on a corner that moved in), and they were
already short: that is the whole of the OBJECTIVE's rise; no face count changes, and the per-line table does not get
worse. Neither rule works alone: the trim alone leaves held-out under (2.3 -> 3.0 %), the tuck alone leaves dev over
(3.9 -> 5.7 %).

## The gates

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

## Under-coverage (the orchestrator's addition)

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

"""Would a free footprint help as an outline-extent hint? DEV only. For each house: align the footprint to our outline
(best translation <= 3 m, our outline as the reference: no truth involved), and when it is the same building
(IoU >= SAME) and larger than ours by more than GROW, take union(ours, footprint). Score both against every key the
footprint is independent of. Usage: hint_experiment.py <source> [GROW] [SAME] [split]"""
import json, statistics, sys
from shapely import affinity
from houses import houses, FREE
from geo import utm_for, to_xy, compare, best_shift, iou
from compare import pick_any
import truths

src = sys.argv[1]
GROW = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
SAME = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
SPLIT = sys.argv[4] if len(sys.argv) > 4 else "dev"
res = {}
acted = 0
for h in houses():
    if h["split"] != SPLIT: continue
    tr = utm_for(h["lng"], h["lat"])
    o = json.loads((FREE / "ours" / f"{h['slug']}.json").read_text())
    f = FREE / src / f"{h['slug']}.json"
    if o["roof"] is None or not f.exists(): continue
    ours = to_xy(tr, [o["roof"]["outline"]])
    fp, ld = pick_any(json.loads(f.read_text())["features"], h, tr, with_flag=True)
    hint = ours
    if fp is not None:
        v, dx, dy = best_shift(ours, fp)
        fpa = affinity.translate(fp, dx, dy)
        if v >= SAME and fpa.area > ours.area * (1 + GROW):
            hint = ours.union(fpa); acted += 1
    for kname, fn in (("eagleview", truths.eagleview), ("lidar", truths.lidar), ("county", truths.county)):
        k = fn(h, tr)
        if k is None: continue
        if kname == "lidar" and ld: continue  # the footprint was traced from lidar: circular
        a, b = compare(ours, k), compare(hint, k)
        res.setdefault(kname, []).append((h["canopy"], a, b, hint is not ours))
print(f"{src} GROW={GROW} SAME={SAME} split={SPLIT}: acted on {acted} houses")
for kname, rs in res.items():
    for grp in ("all", "trees"):
        sel = [r for r in rs if grp == "all" or r[0] in ("light", "heavy")]
        if not sel: continue
        m = lambda i, key: statistics.median(r[i][key] for r in sel)
        ma = lambda i: statistics.median(abs(r[i]["planErrPct"]) for r in sel)
        mean_iou = lambda i: statistics.mean(r[i]["alignedIoU"] for r in sel)
        worse = sum(1 for r in sel if r[2]["alignedIoU"] < r[1]["alignedIoU"] - 0.01)
        better = sum(1 for r in sel if r[2]["alignedIoU"] > r[1]["alignedIoU"] + 0.01)
        print(f"  {kname:9s} {grp:5s} n={len(sel):2d} IoU med {m(1,'alignedIoU'):.3f}->{m(2,'alignedIoU'):.3f} mean {mean_iou(1):.3f}->{mean_iou(2):.3f} "
              f"| signed plan {m(1,'planErrPct'):+.1f}->{m(2,'planErrPct'):+.1f} | abs plan {ma(1):.1f}->{ma(2):.1f} | better {better} worse {worse}")

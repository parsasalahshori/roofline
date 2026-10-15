"""Ranking tables from free/comparison.json (compare.py): per answer key, split and tree cover, every source against
ours on the SAME houses (paired), so a source that only covers easy houses cannot look better than it is.
Prints Markdown to stdout."""
import json, statistics
from collections import defaultdict
from houses import FREE

rows = json.loads((FREE / "comparison.json").read_text())
SOURCES = ["ours", "google-bi", "ms", "osm", "osm-ov", "overture", "geostor-composite", "county"]
med = lambda xs: statistics.median(xs) if xs else None
f = lambda x, d=3: "-" if x is None else f"{x:.{d}f}"

by = defaultdict(dict)  # (key, slug) -> source -> row
meta = {}
for r in rows:
    by[(r["key"], r["slug"])][r["source"]] = r
    meta[r["slug"]] = (r["split"], r["canopy"])


def table(key, split, canopy):
    sel = [(k, s) for (k, s) in by if k == key and (split == "all" or meta[s][0] == split) and (canopy == "all" or (meta[s][1] in ("light", "heavy") if canopy == "trees" else meta[s][1] == canopy))]
    if not sel: return None
    out = [f"| source | houses | aligned IoU (src / ours) | IoU wins vs ours | plan err % signed (src / ours) | abs plan err % (src / ours) | abs sloped err % (src / ours) | pitch within 1/12 (src / ours) |",
           "|---|---|---|---|---|---|---|---|"]
    for src in SOURCES:
        pairs = [(by[k][src], by[k].get("ours")) for k in sel if src in by[k] and by[k].get("ours") is not None]
        if not pairs: continue
        a = lambda key2, which: [p[which][key2] for p in pairs if p[which].get(key2) is not None]
        iou_s, iou_o = a("alignedIoU", 0), a("alignedIoU", 1)
        wins = sum(1 for s, o in pairs if s.get("alignedIoU") is not None and s["alignedIoU"] > o["alignedIoU"])
        nwin = sum(1 for s, o in pairs if s.get("alignedIoU") is not None)
        pe_s, pe_o = a("planErrPct", 0), a("planErrPct", 1)
        se_s, se_o = [abs(x) for x in a("slopedErrPct", 0)], [abs(x) for x in a("slopedErrPct", 1)]
        pi_s, pi_o = a("pitchErr", 0), a("pitchErr", 1)
        share = lambda xs: f"{sum(1 for x in xs if x <= 1)}/{len(xs)}" if xs else "-"
        out.append(f"| {src} | {len(pairs)}/{len(sel)} | {f(med(iou_s))} / {f(med(iou_o))} | {f'{wins}/{nwin}' if nwin else '-'} | "
                   f"{f(med(pe_s),1)} / {f(med(pe_o),1)} | {f(med([abs(x) for x in pe_s]),1)} / {f(med([abs(x) for x in pe_o]),1)} | "
                   f"{f(med(se_s),1)} / {f(med(se_o),1)} | {share(pi_s)} / {share(pi_o)} |")
    return "\n".join(out)


for key in ("eagleview", "lidar", "county"):
    for split in ("dev", "heldout"):
        for canopy in ("all", "none", "trees", "heavy"):
            t = table(key, split, canopy)
            if t:
                print(f"\n#### {key} truth, {split.upper()}, tree cover: {canopy}\n\n{t}")


def pooled():
    """The same tables over DEV and HELD-OUT together (headline ranking)."""
    out = []
    for key in ("eagleview", "lidar", "county"):
        for c in ("all", "trees", "heavy"):
            t = table(key, "all", c)
            if t: out.append(f"\n#### {key} truth, DEV+HELDOUT, tree cover: {c}\n\n{t}")
    return "\n".join(out)

"""Microsoft Global ML Building Footprints (ODbL) round each benchmark house, into free/ms/<slug>.json.

Streams each house's level-9 quadkey part (gzip, GeoJSON lines) once and keeps only polygons within RADIUS_M of a
house, so the 2 GB of parts never touch disk. Links come from dataset-links.csv (free/ms-dataset-links.csv).
Each feature keeps the release's properties (height, confidence) and the part's upload date.
"""
import csv, gzip, io, json, math, sys
import requests
from houses import houses, bbox, write, UA, FREE

MAX_PART_BYTES = 400 * 1024 * 1024  # the largest US part is ~160 MB


def quadkey(lng, lat, z=9):
    x = (lng + 180) / 360
    s = math.sin(math.radians(lat))
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    n = 2 ** z
    tx, ty = int(x * n), int(y * n)
    k = ""
    for i in range(z, 0, -1):
        m = 1 << (i - 1)
        k += str((1 if tx & m else 0) + (2 if ty & m else 0))
    return k


def main():
    rows = {r["QuadKey"]: r for r in csv.DictReader(open(FREE / "ms-dataset-links.csv")) if r["Location"] == "UnitedStates"}
    groups = {}
    for h in houses():
        if (FREE / "ms" / f"{h['slug']}.json").exists():
            continue
        groups.setdefault(quadkey(h["lng"], h["lat"]), []).append(h)
    for k, hs in sorted(groups.items()):
        row = rows[k]
        boxes = [(h, bbox(h["lng"], h["lat"])) for h in hs]
        feats = {h["slug"]: [] for h in hs}
        r = requests.get(row["Url"], headers={"User-Agent": UA}, stream=True, timeout=(20, 120))
        r.raise_for_status()
        raw = r.raw
        raw.decode_content = False
        got = 0
        class Lim(io.RawIOBase):
            def readable(self): return True
            def readinto(self, b):
                nonlocal got
                d = raw.read(len(b))
                got += len(d)
                if got > MAX_PART_BYTES: raise RuntimeError("part too large")
                b[: len(d)] = d
                return len(d)
        for line in io.TextIOWrapper(gzip.GzipFile(fileobj=io.BufferedReader(Lim())), encoding="utf-8"):
            # Cheap prefilter on the first coordinate before parsing JSON.
            i = line.find("[[[")
            if i < 0: continue
            j = line.find("]", i)
            try:
                x0, y0 = (float(v) for v in line[i + 3 : j].split(",")[:2])
            except ValueError:
                continue
            hit = [h for h, (w, s, e, n) in boxes if w - 0.001 < x0 < e + 0.001 and s - 0.001 < y0 < n + 0.001]
            if not hit: continue
            f = json.loads(line)
            ring = f["geometry"]["coordinates"][0]
            for h in hit:
                w, s, e, n = bbox(h["lng"], h["lat"])
                if any(w < x < e and s < y < n for x, y in ring):
                    feats[h["slug"]].append({"id": f"ms/{k}/{len(feats[h['slug']])}", "rings": [ring], "props": f.get("properties", {})})
        for h in hs:
            write("ms", h["slug"], {"source": "ms", "license": "ODbL (Microsoft Global ML Building Footprints)", "part": row["Url"].split("/")[-2], "uploadDate": row["UploadDate"], "features": feats[h["slug"]]})
            print(h["slug"], len(feats[h["slug"]]), flush=True)


if __name__ == "__main__":
    main()

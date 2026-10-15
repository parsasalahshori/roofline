"""Overture Maps buildings (ODbL / CDLA mix, per source) round each benchmark house, into free/overture/<slug>.json.

Reads the release's GeoParquet straight from the public S3 bucket with DuckDB (bbox-column pushdown, so only the
row groups near a house are fetched). Each feature keeps its `sources` (OpenStreetMap, Microsoft ML, Esri, ...)
so the comparison can split Overture by where each footprint came from.
"""
import json, sys
import duckdb
from houses import houses, bbox, write, FREE

RELEASE = "2026-09-23.0"
PATH = f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*"


def main():
    con = duckdb.connect()
    for s in ("INSTALL spatial", "LOAD spatial", "INSTALL httpfs", "LOAD httpfs", "SET s3_region='us-west-2'", "SET http_timeout=120000"):
        con.execute(s)
    for h in houses():
        if (FREE / "overture" / f"{h['slug']}.json").exists():
            continue
        w, s, e, n = bbox(h["lng"], h["lat"])
        rows = con.execute(
            f"""SELECT id, ST_AsGeoJSON(geometry), to_json(sources), height, num_floors, roof_shape, class
                FROM read_parquet('{PATH}', hive_partitioning=1)
                WHERE bbox.xmin < ? AND bbox.xmax > ? AND bbox.ymin < ? AND bbox.ymax > ?""",
            [e, w, n, s],
        ).fetchall()
        feats = []
        for rid, gj, src, height, floors, roof_shape, cls in rows:
            g = json.loads(gj)
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
            rings = [p[0] for p in polys]
            if not rings: continue
            feats.append({"id": rid, "rings": rings, "props": {"sources": json.loads(src) if src else None, "height": height, "num_floors": floors, "roof_shape": roof_shape, "class": cls}})
        feats.sort(key=lambda f: f["id"])
        write("overture", h["slug"], {"source": "overture", "release": RELEASE, "license": "ODbL/CDLA per source (Overture Maps Foundation)", "features": feats})
        print(h["slug"], len(feats), flush=True)


if __name__ == "__main__":
    main()

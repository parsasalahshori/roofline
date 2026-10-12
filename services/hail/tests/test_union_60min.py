import gzip
import json
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from shapely.ops import unary_union

from hail.contours import contour_grid, reproject
from hail.storms import match_existing, split_storms

FIXTURES = Path(__file__).parent / "fixtures"
FIRST = "MRMS_MESH_Max_60min_00.50_20240527-230000.grib2.gz"
SECOND = "MRMS_MESH_Max_60min_00.50_20240528-000000.grib2.gz"
BIG = 500.0  # km2: below this the contour/cell-count gap is noise
TOL_LOW = 0.92
TOL_HIGH = 1.01


def area_km2(geom) -> float:
    return reproject(geom, 4326, 5070).area / 1e6


def _contour(tmp_path_factory, name: str):
    out = tmp_path_factory.mktemp("grib60") / "mesh.grib2"
    with gzip.open(FIXTURES / name, "rb") as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst)
    return contour_grid(out)


@pytest.fixture(scope="module")
def expected():
    with open(FIXTURES / "expected-60min.json") as fh:
        return json.load(fh)["cell_area_km2"]


@pytest.fixture(scope="module")
def first_contours(tmp_path_factory):
    return _contour(tmp_path_factory, FIRST)


@pytest.fixture(scope="module")
def second_contours(tmp_path_factory):
    return _contour(tmp_path_factory, SECOND)


def by_level(contours) -> dict[float, object]:
    return {c.threshold_in: c.geom for c in contours}


def union_by_level(a, b) -> dict[float, object]:
    ga, gb = by_level(a), by_level(b)
    return {lvl: unary_union([ga[lvl], gb[lvl]]) for lvl in ga if lvl in gb}


def test_each_60min_grid_area_matches_oracle(first_contours, second_contours, expected):
    checked = 0
    for name, contours in (("first", first_contours), ("second", second_contours)):
        geoms = by_level(contours)
        for k, want in expected[name].items():
            if want < BIG:
                continue
            got = area_km2(geoms[float(k)])
            assert want * TOL_LOW <= got <= want * TOL_HIGH, f"{name} level {k}: {got:.1f} vs {want}"
            checked += 1
    assert checked >= 4


def test_union_of_two_grids_matches_union_oracle(first_contours, second_contours, expected):
    union = union_by_level(first_contours, second_contours)
    ga, gb = by_level(first_contours), by_level(second_contours)
    checked = 0
    for k, want in expected["union"].items():
        if want < BIG:
            continue
        lvl = float(k)
        got = area_km2(union[lvl])
        assert want * TOL_LOW <= got <= want * TOL_HIGH, f"union level {k}: {got:.1f} vs {want}"
        assert got >= max(area_km2(ga[lvl]), area_km2(gb[lvl])) * 0.999
        checked += 1
    assert checked >= 4
    assert area_km2(union[0.75]) == pytest.approx(7074.6, rel=0.08)


def test_union_never_smaller_than_either_input(first_contours, second_contours):
    union = union_by_level(first_contours, second_contours)
    ga, gb = by_level(first_contours), by_level(second_contours)
    assert union
    for lvl, geom in union.items():
        got = area_km2(geom)
        assert got >= area_km2(ga[lvl]) * 0.999, lvl
        assert got >= area_km2(gb[lvl]) * 0.999, lvl


def test_split_and_match_union_keeps_one_id_across_two_grids(first_contours, second_contours):
    shapes1 = split_storms(first_contours)
    shapes2 = split_storms(second_contours)
    assert shapes1 and shapes2
    t0 = datetime(2024, 5, 27, 23, 0, tzinfo=timezone.utc)
    ids = [uuid.uuid4() for _ in shapes1]
    existing = [(sid, s.footprint, t0 + timedelta(seconds=i)) for i, (sid, s) in enumerate(zip(ids, shapes1))]
    matches = match_existing(shapes2, existing)
    assert matches
    seen: set[uuid.UUID] = set()
    overlapping = 0
    for m in matches:
        touched = [sid for sid, s in zip(ids, shapes1) if s.footprint.intersection(m.shape.footprint).area > 0]
        if touched:
            overlapping += 1
            assert m.storm_id == min(touched, key=lambda i: ids.index(i))
            assert sorted(m.merged_ids, key=ids.index) == sorted(set(touched) - {m.storm_id}, key=ids.index)
            assert m.storm_id not in seen
            seen.add(m.storm_id)
            seen.update(m.merged_ids)
        else:
            assert m.storm_id is None
    assert overlapping >= 1
    # no stored storm is claimed by two matches
    claimed = [m.storm_id for m in matches if m.storm_id] + [i for m in matches for i in m.merged_ids]
    assert len(claimed) == len(set(claimed))

import gzip
import json
import re
import shutil
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
import shapely

from hail import units
from hail.contours import contour_grid, reproject

FIXTURES = Path(__file__).parent / "fixtures"
SHARED_STORM = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "storm.ts"


def key(level: float) -> str:
    return f"{level:g}"


def area_km2(geom) -> float:
    return reproject(geom, 4326, 5070).area / 1e6


@pytest.fixture(scope="module")
def expected():
    with open(FIXTURES / "expected.json") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def contours(tmp_path_factory):
    out = tmp_path_factory.mktemp("grib") / "mesh.grib2"
    with gzip.open(FIXTURES / "MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2.gz", "rb") as src:
        with open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return {c.threshold_in: c.geom for c in contour_grid(out)}


def test_levels_match_shared_constant(contours):
    text = SHARED_STORM.read_text()
    match = re.search(r"HAIL_LEVELS_IN\s*=\s*\[([^\]]*)\]", text)
    assert match is not None
    parsed = tuple(float(x) for x in match.group(1).split(",") if x.strip())
    assert parsed == units.HAIL_LEVELS_IN
    assert units.MM_PER_IN == 25.4
    for level in units.HAIL_LEVELS_IN:
        assert level in contours, f"missing contour for level {level}"


def test_convective_day_boundaries():
    assert units.convective_day(datetime(2024, 5, 28, 11, 59, 59, tzinfo=UTC)) == date(2024, 5, 27)
    assert units.convective_day(datetime(2024, 5, 28, 12, 0, 0, tzinfo=UTC)) == date(2024, 5, 28)
    assert units.convective_day(datetime(2024, 5, 28, 0, 0, tzinfo=UTC)) == date(2024, 5, 27)
    assert units.convective_day(datetime(2024, 5, 28, 12, 0)) == date(2024, 5, 28)


def test_points_inside_outside(contours, expected):
    for pt in expected["points"]:
        geom = contours[float(pt["level_in"])]
        hit = geom.intersects(shapely.Point(pt["lon"], pt["lat"]))
        if pt["inside"]:
            assert hit, f"expected inside: {pt}"
        else:
            assert not hit, f"expected outside: {pt}"


def test_area_matches_cell_count_oracle(contours, expected):
    for k, want in expected["cell_area_km2"].items():
        if want < 500:
            continue
        got = area_km2(contours[float(k)])
        assert abs(got - want) / want <= 0.05, f"level {k}: area {got:.1f} vs expected {want}"


def test_area_regression_snapshot(contours, expected):
    areas = {key(lv): round(area_km2(contours[lv]), 1) for lv in units.HAIL_LEVELS_IN}
    if "contour_area_km2" not in expected:
        pytest.fail("capture contour_area_km2 into expected.json: " + json.dumps(areas))
    for k, want in expected["contour_area_km2"].items():
        assert abs(areas[k] - want) / want <= 0.02, f"level {k}: area {areas[k]} vs snapshot {want}"


def test_levels_nested(contours):
    levels = sorted(contours)
    for lo, hi in zip(levels, levels[1:], strict=False):
        outside = contours[hi].difference(contours[lo].buffer(0.0005))
        assert outside.area == 0, f"level {hi} not inside level {lo}"
        assert area_km2(contours[hi]) < area_km2(contours[lo])

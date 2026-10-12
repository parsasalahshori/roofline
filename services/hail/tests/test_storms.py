import uuid
from datetime import datetime, timedelta, timezone

import pytest
from shapely.geometry import MultiPolygon, box

from hail.contours import Contour
from hail.storms import StormShape, match_existing, split_storms


def mp(*boxes):
    return MultiPolygon(list(boxes))


def shape(*boxes):
    geom = mp(*boxes)
    return StormShape(footprint=geom, contours={0.75: geom}, max_in=0.75)


def test_split_two_disjoint_cells():
    shapes = split_storms(
        [
            Contour(0.75, mp(box(0, 0, 2, 2), box(10, 10, 12, 12))),
            Contour(1.0, mp(box(0.5, 0.5, 1.5, 1.5), box(10.5, 10.5, 11.5, 11.5))),
        ]
    )
    assert len(shapes) == 2
    for s in shapes:
        assert set(s.contours) == {0.75, 1.0}
        assert s.max_in == 1.0
        assert s.footprint.buffer(1e-9).contains(s.contours[1.0])


def test_split_higher_levels_clipped():
    shapes = split_storms(
        [Contour(0.75, mp(box(0, 0, 4, 4))), Contour(2.0, mp(box(1, 1, 2, 2), box(20, 20, 21, 21)))]
    )
    assert len(shapes) == 1
    assert shapes[0].contours[2.0].area == pytest.approx(1.0)
    assert shapes[0].max_in == 2.0


def test_split_without_footprint_level_returns_empty():
    assert split_storms([Contour(1.0, mp(box(0, 0, 1, 1)))]) == []


T0 = datetime(2002, 6, 5, 15, 0, tzinfo=timezone.utc)


def test_match_keeps_id_on_overlap():
    id1 = uuid.uuid4()
    result = match_existing([shape(box(0.5, 0.5, 2.5, 2.5))], [(id1, mp(box(0, 0, 2, 2)), T0)])
    assert len(result) == 1
    assert result[0].storm_id == id1
    assert result[0].merged_ids == []


def test_match_two_consecutive_runs_keep_ids():
    cells = [box(0, 0, 2, 2), box(10, 10, 12, 12)]
    run1 = split_storms([Contour(0.75, mp(*cells))])
    ids = {i: uuid.uuid4() for i in range(len(run1))}
    existing = [(ids[i], s.footprint, T0) for i, s in enumerate(run1)]
    grown = [c.buffer(0.2, join_style=2) for c in cells]
    run2 = split_storms([Contour(0.75, mp(*grown))])
    matched = match_existing(run2, existing)
    assert len(matched) == 2
    for m in matched:
        original = next(i for i, r in enumerate(run1) if r.footprint.intersects(m.shape.footprint))
        assert m.storm_id == ids[original]


def test_non_overlapping_shape_is_new():
    id1 = uuid.uuid4()
    result = match_existing(
        [shape(box(-0.2, -0.2, 2.2, 2.2)), shape(box(50, 50, 52, 52))], [(id1, mp(box(0, 0, 2, 2)), T0)]
    )
    by_id = {m.storm_id: m for m in result}
    assert set(by_id) == {id1, None}
    assert by_id[None].merged_ids == []
    assert by_id[None].shape.footprint.intersects(box(51, 51, 51.5, 51.5))


def test_two_cells_that_merge_keep_the_oldest_id():
    a, b = uuid.uuid4(), uuid.uuid4()
    existing = [
        (b, mp(box(8, 0, 12, 10)), T0 + timedelta(minutes=30)),
        (a, mp(box(0, 0, 4, 10)), T0),
    ]
    bridge = shape(box(0, 0, 12, 10))
    result = match_existing([bridge], existing)
    assert len(result) == 1
    assert result[0].storm_id == a
    assert result[0].merged_ids == [b]
    assert result[0].shape.footprint.buffer(1e-9).contains(box(4, 0, 8, 10))


def test_split_cell_keeps_one_id():
    a = uuid.uuid4()
    s1, s2 = shape(box(0, 0, 3, 10)), shape(box(6, 0, 9, 10))
    result = match_existing([s1, s2], [(a, mp(box(0, 0, 9, 10)), T0)])
    assert len(result) == 1
    assert result[0].storm_id == a
    assert result[0].merged_ids == []
    assert result[0].shape.footprint.area == pytest.approx(s1.footprint.area + s2.footprint.area)
    assert result[0].shape.contours[0.75].area == pytest.approx(60.0)


def test_oldest_tie_broken_by_id():
    lo, hi = sorted([uuid.uuid4(), uuid.uuid4()], key=str)
    existing = [(hi, mp(box(0, 0, 5, 10)), T0), (lo, mp(box(5, 0, 10, 10)), T0)]
    result = match_existing([shape(box(0, 0, 10, 10))], existing)
    assert result[0].storm_id == lo
    assert result[0].merged_ids == [hi]


def test_existing_without_overlap_is_left_alone():
    id1 = uuid.uuid4()
    result = match_existing([shape(box(0, 0, 2, 2))], [(id1, mp(box(50, 50, 52, 52)), T0)])
    assert len(result) == 1
    assert result[0].storm_id is None
    assert result[0].merged_ids == []

import uuid

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


def test_match_keeps_id_on_overlap():
    id1 = uuid.uuid4()
    result = match_existing([shape(box(0.5, 0.5, 2.5, 2.5))], [(id1, mp(box(0, 0, 2, 2)))])
    assert result[0][0] == id1


def test_match_two_consecutive_runs_keep_ids():
    cells = [box(0, 0, 2, 2), box(10, 10, 12, 12)]
    run1 = split_storms([Contour(0.75, mp(*cells))])
    ids = {i: uuid.uuid4() for i in range(len(run1))}
    existing = [(ids[i], s.footprint) for i, s in enumerate(run1)]
    grown = [c.buffer(0.2, join_style=2) for c in cells]
    run2 = split_storms([Contour(0.75, mp(*grown))])
    matched = match_existing(run2, existing)
    for sid, s in matched:
        original = next(i for i, r in enumerate(run1) if r.footprint.intersects(s.footprint))
        assert sid == ids[original]


def test_match_new_disjoint_cell_gets_none():
    id1 = uuid.uuid4()
    result = match_existing(
        [shape(box(-0.2, -0.2, 2.2, 2.2)), shape(box(50, 50, 52, 52))], [(id1, mp(box(0, 0, 2, 2)))]
    )
    assert result[0][0] == id1
    assert result[1][0] is None


def test_match_overlapping_two_larger_overlap_wins():
    id1, id2 = uuid.uuid4(), uuid.uuid4()
    result = match_existing(
        [shape(box(0, 0, 10, 10))], [(id1, mp(box(0, 0, 6, 10))), (id2, mp(box(8, 0, 12, 10)))]
    )
    assert result[0][0] == id1


def test_match_existing_not_double_assigned():
    id1 = uuid.uuid4()
    s1 = shape(box(0, 0, 10, 10))
    s2 = shape(box(9, 0, 20, 10))
    result = match_existing([s1, s2], [(id1, mp(box(0, 0, 9.5, 10)))])
    assert result[0][0] == id1
    assert result[1][0] is None

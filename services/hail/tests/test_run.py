from datetime import date, datetime, timezone

import pytest
from shapely.geometry import MultiPolygon, box

from hail import run
from hail.contours import Contour
from hail.run import TickFailed, tick
from hail.source import HailGrid


class FakeSource:
    name = "fake"

    def __init__(self, grids):
        self.grids = list(grids)
        self.after_keys = []
        self.close_days = []

    def latest(self, after_key, close_days=()):
        self.after_keys.append(after_key)
        self.close_days.append(tuple(close_days))
        return self.grids.pop(0) if self.grids else None


def mp(*boxes):
    return MultiPolygon(list(boxes))


def level_pair(outer, inner):
    return [Contour(0.75, mp(outer)), Contour(1.0, mp(inner))]


BASE = level_pair(box(-97, 35, -96, 36), box(-96.8, 35.2, -96.4, 35.6))
GROWN = level_pair(box(-97, 35, -95.9, 36.1), box(-96.8, 35.2, -96.3, 35.7))
FAR = [Contour(0.75, mp(box(-90, 30, -89, 31))), Contour(1.0, mp(box(-89.8, 30.2, -89.4, 30.6)))]
BOTH = [Contour(a.threshold_in, mp(*a.geom.geoms, *b.geom.geoms)) for a, b in zip(BASE, FAR)]


def grid(tmp_path, name, key, valid_at, product="60min"):
    path = tmp_path / name
    path.touch()
    return HailGrid(valid_at=valid_at, key=key, path=path, product=product)


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


def now():
    return utc(2002, 6, 5, 15, 30)


SMALL = level_pair(box(-96.9, 35.1, -96.1, 35.9), box(-96.7, 35.3, -96.5, 35.5))
KEY_60 = "CONUS/MESH_Max_60min_00.50/20020605/MRMS_MESH_Max_60min_00.50_20020605-150000.grib2.gz"
KEY_1440_0606 = "CONUS/MESH_Max_1440min_00.50/20020606/MRMS_MESH_Max_1440min_00.50_20020606-120000.grib2.gz"


KEY_1440_0605 = "CONUS/MESH_Max_1440min_00.50/20020605/MRMS_MESH_Max_1440min_00.50_20020605-120000.grib2.gz"
SELECT_0605 = "SELECT id, status, updated_at FROM storms WHERE convective_day = '2002-06-05'"


def area_075(conn, day):
    row = conn.execute(
        "SELECT COALESCE(sum(ST_Area(geom_075::geography)), 0) FROM storms WHERE convective_day = %s", (day,)
    ).fetchone()
    return float(row[0])


def test_two_consecutive_runs_keep_storm_ids(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 5, 15, 30)),
        ]
    )
    answers = [BASE, GROWN]
    monkeypatch.setattr(run, "contour_grid", lambda path: answers.pop(0))
    s1 = tick(source, conn_factory, now())
    s2 = tick(source, conn_factory, now())
    with conn_factory() as conn:
        rows = conn.execute("SELECT count(*), count(DISTINCT id) FROM storms WHERE convective_day = '2002-06-05'")
        assert rows.fetchall() == [(1, 1)]
    assert s1.storm_ids == s2.storm_ids
    assert s2.new_storm_ids == []


def test_new_disjoint_cell_gets_new_id(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 5, 15, 30)),
        ]
    )
    answers = [BASE, BOTH]
    monkeypatch.setattr(run, "contour_grid", lambda path: answers.pop(0))
    tick(source, conn_factory, now())
    s2 = tick(source, conn_factory, now())
    with conn_factory() as conn:
        rows = conn.execute("SELECT count(*) FROM storms WHERE convective_day = '2002-06-05'")
        assert rows.fetchall() == [(2,)]
    assert len(s2.new_storm_ids) == 1


def test_final_1440_run_closes_previous_day(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 6, 12, 0), "1440min"),
        ]
    )
    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    first = tick(source, conn_factory, utc(2002, 6, 5, 15, 30))
    assert first.final is False
    summary = tick(source, conn_factory, utc(2002, 6, 6, 12, 34))
    assert summary.final is True
    assert summary.convective_day == date(2002, 6, 5)
    assert source.close_days[1] == (date(2002, 6, 5),)
    with conn_factory() as conn:
        rows = conn.execute("SELECT status FROM storms WHERE convective_day = '2002-06-05'").fetchall()
    assert rows == [("final",)]


def test_13z_grid_after_final_creates_no_previous_day_copies(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", KEY_60, utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", KEY_1440_0606, utc(2002, 6, 6, 12, 0), "1440min"),
            grid(tmp_path, "g3.grib2", "test-60-0606-13", utc(2002, 6, 6, 13, 0)),
        ]
    )
    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    tick(source, conn_factory, utc(2002, 6, 5, 15, 30))
    closing = tick(source, conn_factory, utc(2002, 6, 6, 12, 34))
    assert closing.final is True
    with conn_factory() as conn:
        before = conn.execute("SELECT id, status FROM storms WHERE convective_day = '2002-06-05'").fetchall()
    assert len(before) == 1 and before[0][1] == "final"
    latest = tick(source, conn_factory, utc(2002, 6, 6, 13, 34))
    assert latest.final is False
    assert latest.convective_day == date(2002, 6, 6)
    assert source.close_days[2] == ()
    with conn_factory() as conn:
        after = conn.execute("SELECT id, status FROM storms WHERE convective_day = '2002-06-05'").fetchall()
        today = conn.execute("SELECT count(*), min(status) FROM storms WHERE convective_day = '2002-06-06'").fetchall()
    assert after == before
    assert today == [(1, "provisional")]


def test_two_consecutive_60min_grids_union_never_shrink(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 5, 16, 0)),
            grid(tmp_path, "g3.grib2", "test-run-3", utc(2002, 6, 5, 17, 0)),
        ]
    )
    answers = [BASE, SMALL, GROWN]
    monkeypatch.setattr(run, "contour_grid", lambda path: answers.pop(0))
    tick(source, conn_factory, utc(2002, 6, 5, 15, 30))
    with conn_factory() as conn:
        first = area_075(conn, date(2002, 6, 5))
    tick(source, conn_factory, utc(2002, 6, 5, 16, 30))
    with conn_factory() as conn:
        second = area_075(conn, date(2002, 6, 5))
        count = conn.execute("SELECT count(*) FROM storms WHERE convective_day = '2002-06-05'").fetchone()[0]
    assert second >= first * 0.999
    assert count == 1
    tick(source, conn_factory, utc(2002, 6, 5, 17, 30))
    with conn_factory() as conn:
        third = area_075(conn, date(2002, 6, 5))
    assert third > second


def test_second_12z_60min_grid_is_provisional_for_new_day(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 6, 12, 4)),
            grid(tmp_path, "g3.grib2", "test-run-3", utc(2002, 6, 6, 12, 34)),
        ]
    )
    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    tick(source, conn_factory, utc(2002, 6, 5, 15, 30))
    with conn_factory() as conn:
        before = conn.execute(SELECT_0605).fetchall()
    for when in (utc(2002, 6, 6, 12, 5), utc(2002, 6, 6, 12, 35)):
        summary = tick(source, conn_factory, when)
        assert summary.final is False
        assert summary.convective_day == date(2002, 6, 6)
    with conn_factory() as conn:
        after = conn.execute(SELECT_0605).fetchall()
        today = conn.execute("SELECT count(*), min(status) FROM storms WHERE convective_day = '2002-06-06'").fetchall()
    assert after == before
    assert today == [(1, "provisional")]


def test_missed_final_is_closed_on_a_later_tick(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 4, 15, 0)),
            grid(tmp_path, "g2.grib2", KEY_1440_0605, utc(2002, 6, 5, 12, 0), "1440min"),
        ]
    )
    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    provisional = tick(source, conn_factory, utc(2002, 6, 4, 15, 30))
    assert provisional.final is False
    summary = tick(source, conn_factory, utc(2002, 6, 6, 15, 0))
    assert date(2002, 6, 4) in source.close_days[1]
    assert summary.final is True
    assert summary.convective_day == date(2002, 6, 4)
    with conn_factory() as conn:
        rows = conn.execute("SELECT status FROM storms WHERE convective_day = '2002-06-04'").fetchall()
    assert rows == [("final",)]


def test_tick_returns_none_when_no_new_grid(conn_factory, clean_db):
    assert tick(FakeSource([]), conn_factory, now()) is None
    with conn_factory() as conn:
        assert conn.execute("SELECT count(*) FROM hail_runs").fetchall() == [(0,)]


def test_failure_raises_tick_failed_with_count_and_success_resets(conn_factory, clean_db, tmp_path, monkeypatch):
    def boom(path):
        raise RuntimeError("boom")

    monkeypatch.setattr(run, "contour_grid", boom)
    when = utc(2002, 6, 5, 15, 0)
    source = FakeSource([grid(tmp_path, f"f{i}.grib2", "test-run-1", when) for i in range(3)])
    for expected in (1, 2, 3):
        with pytest.raises(TickFailed) as info:
            tick(source, conn_factory, now())
        assert info.value.count == expected

    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    good = FakeSource([grid(tmp_path, "ok.grib2", "test-run-1", when)])
    assert tick(good, conn_factory, now()) is not None

    monkeypatch.setattr(run, "contour_grid", boom)
    bad = FakeSource([grid(tmp_path, "later.grib2", "test-run-2", utc(2002, 6, 5, 15, 30))])
    with pytest.raises(TickFailed) as info:
        tick(bad, conn_factory, now())
    assert info.value.count == 1

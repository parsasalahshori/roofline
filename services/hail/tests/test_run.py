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

    def latest(self, after_key):
        self.after_keys.append(after_key)
        return self.grids.pop(0) if self.grids else None


def mp(*boxes):
    return MultiPolygon(list(boxes))


def level_pair(outer, inner):
    return [Contour(0.75, mp(outer)), Contour(1.0, mp(inner))]


BASE = level_pair(box(-97, 35, -96, 36), box(-96.8, 35.2, -96.4, 35.6))
GROWN = level_pair(box(-97, 35, -95.9, 36.1), box(-96.8, 35.2, -96.3, 35.7))
FAR = [Contour(0.75, mp(box(-90, 30, -89, 31))), Contour(1.0, mp(box(-89.8, 30.2, -89.4, 30.6)))]


def grid(tmp_path, name, key, valid_at):
    path = tmp_path / name
    path.touch()
    return HailGrid(valid_at=valid_at, key=key, path=path)


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


def now():
    return datetime.now(timezone.utc)


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
    answers = [BASE, BASE + FAR]
    monkeypatch.setattr(run, "contour_grid", lambda path: answers.pop(0))
    tick(source, conn_factory, now())
    s2 = tick(source, conn_factory, now())
    with conn_factory() as conn:
        rows = conn.execute("SELECT count(*) FROM storms WHERE convective_day = '2002-06-05'")
        assert rows.fetchall() == [(2,)]
    assert len(s2.new_storm_ids) == 1


def test_12z_run_sets_final_and_closes_previous_day(conn_factory, clean_db, tmp_path, monkeypatch):
    source = FakeSource(
        [
            grid(tmp_path, "g1.grib2", "test-run-1", utc(2002, 6, 5, 15, 0)),
            grid(tmp_path, "g2.grib2", "test-run-2", utc(2002, 6, 6, 12, 0)),
        ]
    )
    monkeypatch.setattr(run, "contour_grid", lambda path: BASE)
    first = tick(source, conn_factory, now())
    assert first.final is False
    summary = tick(source, conn_factory, now())
    assert summary.final is True
    assert summary.convective_day == date(2002, 6, 5)
    with conn_factory() as conn:
        rows = conn.execute("SELECT status FROM storms WHERE convective_day = '2002-06-05'").fetchall()
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

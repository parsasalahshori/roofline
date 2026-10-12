from datetime import date, datetime, timezone
from pathlib import Path

import psycopg
from shapely.geometry import MultiPolygon, box

from hail import writer
from hail.source import HailGrid
from hail.storms import StormShape

DAY = date(2001, 5, 5)
COMPANY = "00000000-0000-0000-0000-000000000001"


def grid(key: str, hour: int = 15, minute: int = 0) -> HailGrid:
    return HailGrid(valid_at=datetime(2001, 5, 5, hour, minute, tzinfo=timezone.utc), key=key, path=Path("x"))


def shape(footprint=None, with_inner: bool = True) -> StormShape:
    fp = MultiPolygon([footprint or box(-97, 35, -96, 36)])
    contours = {0.75: fp}
    if with_inner:
        contours[1.0] = MultiPolygon([box(-96.8, 35.2, -96.2, 35.8)])
    return StormShape(footprint=fp, contours=contours, max_in=1.0)


def far_shape() -> StormShape:
    return shape(box(-90, 30, -89, 31))


def scalar(dsn: str, sql: str, params: tuple = ()):
    with psycopg.connect(dsn, autocommit=True) as c:
        return c.execute(sql, params).fetchone()[0]


def test_write_run_inserts_rows_readable_by_app_tenant(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        summary = writer.write_run(conn, grid("test-a"), DAY, [(None, shape())], False)
    with psycopg.connect(owner_dsn, autocommit=True) as c:
        c.execute("SET ROLE app_tenant")
        c.execute("SELECT set_config('app.company_id', %s, false)", (COMPANY,))
        rows = c.execute("SELECT id, status, max_in::float FROM storms WHERE convective_day = %s", (DAY,)).fetchall()
        assert len(rows) == 1
        assert rows[0][1] == "provisional"
        assert rows[0][2] == 1.0
        sid = rows[0][0]
        assert c.execute("SELECT count(*) FROM storm_contours WHERE storm_id = %s", (sid,)).fetchone()[0] == 2
        assert c.execute("SELECT count(*) FROM hail_runs WHERE source_key = 'test-a'").fetchone()[0] == 1
    assert summary.storm_ids == [sid] == summary.new_storm_ids


def test_second_run_keeps_storm_id_and_replaces_contours(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [(None, shape())], False)
        sid = first.storm_ids[0]
        second = writer.write_run(conn, grid("test-b", 15, 30), DAY, [(sid, shape(with_inner=False))], False)
    assert second.storm_ids == [sid]
    assert second.new_storm_ids == []
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s", (DAY,)) == 1
    assert scalar(owner_dsn, "SELECT count(*) FROM storm_contours WHERE storm_id = %s", (sid,)) == 1


def test_new_disjoint_cell_gets_new_id(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [(None, shape())], False)
        sid = first.storm_ids[0]
        second = writer.write_run(conn, grid("test-b", 15, 30), DAY, [(sid, shape()), (None, far_shape())], False)
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s", (DAY,)) == 2
    assert len(second.new_storm_ids) == 1
    assert second.storm_ids[0] == sid


def test_final_run_sets_status_final(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        old = writer.write_run(conn, grid("test-a"), DAY, [(None, far_shape())], False)
        summary = writer.write_run(conn, grid("test-b", 16), DAY, [(None, shape())], True)
    assert summary.final is True
    with psycopg.connect(owner_dsn, autocommit=True) as c:
        for sid in (summary.storm_ids[0], old.storm_ids[0]):
            status, final_at = c.execute("SELECT status, final_at FROM storms WHERE id = %s", (sid,)).fetchone()
            assert status == "final"
            assert final_at is not None


def test_last_grew_at_only_when_area_grows_over_one_percent(hail_dsn, owner_dsn, clean_db):
    sql = "SELECT last_grew_at FROM storms WHERE id = %s"
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [(None, shape())], False)
        sid = first.storm_ids[0]
        before = scalar(owner_dsn, sql, (sid,))
        writer.write_run(conn, grid("test-b", 15, 30), DAY, [(sid, shape())], False)
        assert scalar(owner_dsn, sql, (sid,)) == before
        writer.write_run(conn, grid("test-c", 16), DAY, [(sid, shape(box(-97, 35, -95, 36)))], False)
        assert scalar(owner_dsn, sql, (sid,)) > before


def test_failure_counter_counts_and_resets_on_success(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        counts = []
        for _ in range(3):
            counts.append(writer.record_failure(conn, "test-f", RuntimeError("x")))
            conn.commit()
        assert counts == [1, 2, 3]
        writer.write_run(conn, grid("test-ok"), DAY, [(None, shape())], False)
        conn.commit()
        assert writer.record_failure(conn, "test-f", RuntimeError("x")) == 1
        conn.commit()
    msg = scalar(owner_dsn, "SELECT error_plain FROM hail_runs WHERE status = 'failed' LIMIT 1")
    assert msg == writer.FAILED_MESSAGE


def test_last_processed_key(hail_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        assert writer.last_processed_key(conn) is None
        writer.write_run(conn, grid("test-a"), DAY, [(None, shape())], False)
        assert writer.last_processed_key(conn) == "test-a"

from datetime import date, datetime, timezone
from pathlib import Path

import psycopg
from shapely.geometry import MultiPolygon, box

from hail import writer
from hail.source import HailGrid
from hail.storms import Match, StormShape, match_existing

DAY = date(2002, 6, 5)
COMPANY = "00000000-0000-0000-0000-000000000001"


def grid(key: str, hour: int = 15, minute: int = 0) -> HailGrid:
    return HailGrid(valid_at=datetime(2002, 6, 5, hour, minute, tzinfo=timezone.utc), key=key, path=Path("x"), product="60min")


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
        summary = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
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
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        second = writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(sid, shape(with_inner=False), [])], False, True)
    assert second.storm_ids == [sid]
    assert second.new_storm_ids == []
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s", (DAY,)) == 1
    assert scalar(owner_dsn, "SELECT count(*) FROM storm_contours WHERE storm_id = %s", (sid,)) == 1


def test_new_disjoint_cell_gets_new_id(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        second = writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(sid, shape(), []), Match(None, far_shape(), [])], False, False)
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s", (DAY,)) == 2
    assert len(second.new_storm_ids) == 1
    assert second.storm_ids[0] == sid


def test_final_run_sets_status_final(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        old = writer.write_run(conn, grid("test-a"), DAY, [Match(None, far_shape(), [])], False, False)
        summary = writer.write_run(conn, grid("test-b", 16), DAY, [Match(None, shape(), [])], True, True)
    assert summary.final is True
    with psycopg.connect(owner_dsn, autocommit=True) as c:
        for sid in (summary.storm_ids[0], old.storm_ids[0]):
            status, final_at = c.execute("SELECT status, final_at FROM storms WHERE id = %s", (sid,)).fetchone()
            assert status == "final"
            assert final_at is not None


def test_last_grew_at_only_when_area_grows_over_one_percent(hail_dsn, owner_dsn, clean_db):
    sql = "SELECT last_grew_at FROM storms WHERE id = %s"
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        before = scalar(owner_dsn, sql, (sid,))
        writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(sid, shape(), [])], False, False)
        assert scalar(owner_dsn, sql, (sid,)) == before
        writer.write_run(conn, grid("test-c", 16), DAY, [Match(sid, shape(box(-97, 35, -95, 36)), [])], False, False)
        assert scalar(owner_dsn, sql, (sid,)) > before


def test_failure_counter_counts_and_resets_on_success(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        counts = []
        for _ in range(3):
            counts.append(writer.record_failure(conn, "test-f", RuntimeError("x")))
            conn.commit()
        assert counts == [1, 2, 3]
        writer.write_run(conn, grid("test-ok"), DAY, [Match(None, shape(), [])], False, False)
        conn.commit()
        assert writer.record_failure(conn, "test-f", RuntimeError("x")) == 1
        conn.commit()
    msg = scalar(owner_dsn, "SELECT error_plain FROM hail_runs WHERE status = 'failed' LIMIT 1")
    assert msg == writer.FAILED_MESSAGE


def test_last_processed_key(hail_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        assert writer.last_processed_key(conn) is None
        writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        assert writer.last_processed_key(conn) == "test-a"


def area(dsn: str, sid) -> float:
    return scalar(dsn, "SELECT ST_Area(geom_075::geography) FROM storms WHERE id = %s", (sid,))


def test_union_mode_never_shrinks_area(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        before = area(owner_dsn, sid)
        c_before = scalar(owner_dsn, "SELECT ST_Area(geom::geography) FROM storm_contours WHERE storm_id = %s AND threshold_in = 0.75", (sid,))
        small = shape(box(-96.8, 35.2, -96.2, 35.8))
        writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(sid, small, [])], False, False)
    assert area(owner_dsn, sid) >= before
    assert scalar(owner_dsn, "SELECT count(*) FROM storm_contours WHERE storm_id = %s AND threshold_in = 0.75", (sid,)) == 1
    c_after = scalar(owner_dsn, "SELECT ST_Area(geom::geography) FROM storm_contours WHERE storm_id = %s AND threshold_in = 0.75", (sid,))
    assert c_after >= c_before * 0.999
    # contours present in the DB but absent from the new shape stay
    assert scalar(owner_dsn, "SELECT count(*) FROM storm_contours WHERE storm_id = %s", (sid,)) == 2


def test_union_mode_adds_new_part(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        part = shape(box(-95, 35, -94, 36))
        writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(sid, part, [])], False, False)
    assert scalar(owner_dsn, "SELECT ST_NumGeometries(geom_075) FROM storms WHERE id = %s", (sid,)) == 2
    assert scalar(
        owner_dsn,
        "SELECT ST_Covers(geom_075, ST_GeomFromText('POINT(-94.5 35.5)', 4326)) AND "
        "ST_Covers(geom_075, ST_GeomFromText('POINT(-96.5 35.5)', 4326)) FROM storms WHERE id = %s",
        (sid,),
    )


def test_replace_mode_replaces_shapes(hail_dsn, owner_dsn, clean_db):
    small = shape(box(-96.8, 35.2, -96.2, 35.8), with_inner=False)
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(), [])], False, False)
        sid = first.storm_ids[0]
        writer.write_run(conn, grid("test-b", 16), DAY, [Match(sid, small, [])], True, True)
    status, final_at = (
        psycopg.connect(owner_dsn, autocommit=True)
        .execute("SELECT status, final_at FROM storms WHERE id = %s", (sid,))
        .fetchone()
    )
    assert status == "final"
    assert final_at is not None
    assert scalar(
        owner_dsn,
        "SELECT ST_Equals(geom_075, ST_Multi(ST_MakeEnvelope(-96.8, 35.2, -96.2, 35.8, 4326))) FROM storms WHERE id = %s",
        (sid,),
    )
    assert scalar(owner_dsn, "SELECT count(*) FROM storm_contours WHERE storm_id = %s", (sid,)) == 1


def test_merge_sets_merged_into_and_unions_geometry(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        a = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(box(-97, 35, -96, 36)), [])], False, False)
        b = writer.write_run(conn, grid("test-b", 15, 30), DAY, [Match(None, shape(box(-94, 35, -93, 36)), [])], False, False)
        sa, sb = a.storm_ids[0], b.storm_ids[0]
        bridge = shape(box(-97, 35, -93, 36))
        summary = writer.write_run(conn, grid("test-c", 16), DAY, [Match(sa, bridge, [sb])], False, False)
    assert summary.merged_ids == [sb]
    assert summary.storm_ids == [sa]
    assert scalar(owner_dsn, "SELECT merged_into FROM storms WHERE id = %s", (sb,)) == sa
    assert scalar(owner_dsn, "SELECT merged_into FROM storms WHERE id = %s", (sa,)) is None
    assert scalar(
        owner_dsn,
        "SELECT ST_Covers(a.geom_075, b.geom_075) FROM storms a, storms b WHERE a.id = %s AND b.id = %s",
        (sa, sb),
    )
    assert scalar(
        owner_dsn,
        "SELECT ST_Covers(a.geom, ST_GeomFromText('POINT(-93.5 35.5)', 4326)) FROM storm_contours a "
        "WHERE a.storm_id = %s AND a.threshold_in = 0.75",
        (sa,),
    )
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s", (DAY,)) == 2


def test_split_shapes_one_storm_one_id(hail_dsn, owner_dsn, clean_db):
    with psycopg.connect(hail_dsn) as conn:
        first = writer.write_run(conn, grid("test-a"), DAY, [Match(None, shape(box(-97, 35, -94, 36)), [])], False, False)
        sid = first.storm_ids[0]
        existing = [(sid, shape(box(-97, 35, -94, 36)).footprint, datetime(2002, 6, 5, 15, tzinfo=timezone.utc))]
        pieces = [shape(box(-97, 35, -96, 36)), shape(box(-95, 35, -94, 36))]
        matched = match_existing(pieces, existing)
        summary = writer.write_run(conn, grid("test-b", 15, 30), DAY, matched, False, False)
    assert summary.storm_ids == [sid]
    assert summary.new_storm_ids == []
    assert scalar(owner_dsn, "SELECT count(*) FROM storms WHERE convective_day = %s AND merged_into IS NULL", (DAY,)) == 1

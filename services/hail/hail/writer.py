"""Write hail runs, storms and contours to Postgres as the app_hail role."""

from datetime import date, datetime, timezone
from typing import NamedTuple
from uuid import UUID

import psycopg
import shapely

from hail.source import HailGrid
from hail.storms import StormShape
from hail.units import convective_day

FAILED_MESSAGE = "Hail data could not be processed."


class RunSummary(NamedTuple):
    run_id: int
    key: str
    valid_at: datetime
    convective_day: date
    final: bool
    max_in: float | None
    storm_ids: list[UUID]
    new_storm_ids: list[UUID]


_INSERT_STORM = """
INSERT INTO storms(convective_day, status, max_in, geom_075, bbox, centroid, final_at)
SELECT %s, %s, %s::numeric, n.g, ST_Envelope(n.g), ST_Centroid(n.g), CASE WHEN %s::boolean THEN now() END
FROM (SELECT ST_SetSRID(ST_GeomFromWKB(%s), 4326) AS g) n
RETURNING id
"""

_UPDATE_STORM = """
UPDATE storms s SET
  geom_075 = n.g,
  bbox = ST_Envelope(n.g),
  centroid = ST_Centroid(n.g),
  max_in = GREATEST(s.max_in, %s::numeric),
  updated_at = now(),
  last_grew_at = CASE WHEN ST_Area(n.g::geography) > ST_Area(s.geom_075::geography) * 1.01
                      THEN now() ELSE s.last_grew_at END,
  status = CASE WHEN %s::boolean THEN 'final' ELSE s.status END,
  final_at = CASE WHEN %s::boolean THEN COALESCE(s.final_at, now()) ELSE s.final_at END
FROM (SELECT ST_SetSRID(ST_GeomFromWKB(%s), 4326) AS g) n
WHERE s.id = %s
"""


def write_run(
    conn: psycopg.Connection,
    grid: HailGrid,
    day: date,
    matched: list[tuple[UUID | None, StormShape]],
    final: bool,
) -> RunSummary:
    run_max = max((s.max_in for _, s in matched), default=None)
    storm_ids: list[UUID] = []
    new_ids: list[UUID] = []
    with conn.transaction():
        row = conn.execute(
            "INSERT INTO hail_runs(source_key, valid_at, convective_day, status, max_in) "
            "VALUES (%s, %s, %s, 'processed', %s::numeric) RETURNING id",
            (grid.key, grid.valid_at, day, None if run_max is None else round(run_max, 2)),
        ).fetchone()
        assert row is not None
        run_id = int(row[0])
        for storm_id, shape in matched:
            wkb = bytes(shapely.to_wkb(shape.footprint))
            max_in = round(shape.max_in, 2)
            if storm_id is None:
                created = conn.execute(
                    _INSERT_STORM, (day, "final" if final else "provisional", max_in, final, wkb)
                ).fetchone()
                assert created is not None
                storm_id = created[0]
                new_ids.append(storm_id)
            else:
                conn.execute(_UPDATE_STORM, (max_in, final, final, wkb, storm_id))
            storm_ids.append(storm_id)
            conn.execute("DELETE FROM storm_contours WHERE storm_id = %s", (storm_id,))
            for threshold, geom in shape.contours.items():
                conn.execute(
                    "INSERT INTO storm_contours(storm_id, threshold_in, geom) "
                    "VALUES (%s, %s::numeric, ST_SetSRID(ST_GeomFromWKB(%s), 4326))",
                    (storm_id, threshold, bytes(shapely.to_wkb(geom))),
                )
        if final:
            conn.execute(
                "UPDATE storms SET status = 'final', final_at = COALESCE(final_at, now()) "
                "WHERE convective_day = %s AND status <> 'final'",
                (day,),
            )
    return RunSummary(
        run_id=run_id,
        key=grid.key,
        valid_at=grid.valid_at,
        convective_day=day,
        final=final,
        max_in=None if run_max is None else float(run_max),
        storm_ids=storm_ids,
        new_storm_ids=new_ids,
    )


def record_failure(conn: psycopg.Connection, key: str, err: Exception) -> int:
    """Record a failed run; returns the consecutive failure count. The error text is never stored."""
    del err
    valid_at = datetime.now(timezone.utc)
    day = convective_day(valid_at)
    with conn.transaction():
        conn.execute(
            "INSERT INTO hail_runs(source_key, valid_at, convective_day, status, error_plain) "
            "VALUES (%s, %s, %s, 'failed', %s)",
            (f"{key}#failed:{valid_at.isoformat()}", valid_at, day, FAILED_MESSAGE),
        )
        row = conn.execute(
            "SELECT count(*) FROM hail_runs WHERE status = 'failed' AND processed_at > "
            "COALESCE((SELECT max(processed_at) FROM hail_runs WHERE status = 'processed'), '-infinity'::timestamptz)"
        ).fetchone()
    assert row is not None
    return int(row[0])


def last_processed_key(conn: psycopg.Connection) -> str | None:
    row = conn.execute(
        "SELECT source_key FROM hail_runs WHERE status = 'processed' ORDER BY valid_at DESC LIMIT 1"
    ).fetchone()
    return None if row is None else row[0]

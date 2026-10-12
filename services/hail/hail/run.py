"""One tick: fetch the newest grid, contour it, group storms and write the run."""

import logging
from datetime import date, datetime, timedelta

import shapely

from hail.contours import contour_grid
from hail.source import HailSource
from hail.storms import match_existing, split_storms
from hail.units import convective_day
from hail.writer import RunSummary, record_failure, write_run

log = logging.getLogger(__name__)


class TickFailed(Exception):
    def __init__(self, count: int):
        super().__init__("hail tick failed")
        self.count = count


def _close_days(conn, current: date) -> list[date]:
    """Convective days before `current` that still lack their final 1440min run."""
    rows = conn.execute(
        "SELECT convective_day FROM storms WHERE convective_day < %s AND status <> 'final' "
        "UNION SELECT convective_day FROM hail_runs WHERE status = 'processed' AND convective_day < %s",
        (current, current),
    ).fetchall()
    days = {row[0] for row in rows}
    if not days:
        return []
    closed = conn.execute(
        "SELECT DISTINCT convective_day FROM hail_runs "
        "WHERE status = 'processed' AND source_key LIKE '%%MESH_Max_1440min%%' AND convective_day = ANY(%s)",
        (sorted(days),),
    ).fetchall()
    open_days = days - {row[0] for row in closed}
    cutoff = current - timedelta(days=3)
    for day in sorted(d for d in open_days if d < cutoff):
        log.warning("giving up closing convective day %s: no 1440min key after 3 days", day)
    return sorted(d for d in open_days if d >= cutoff)


def tick(source: HailSource, conn_factory, now: datetime) -> RunSummary | None:
    with conn_factory() as conn:
        grid = None
        try:
            current = convective_day(now)
            close_days = _close_days(conn, current)
            row = conn.execute(
                "SELECT source_key FROM hail_runs WHERE status = 'processed' AND source_key LIKE '%%MESH_Max_60min%%' "
                "ORDER BY valid_at DESC LIMIT 1"
            ).fetchone()
            after = row[0] if row else None
            grid = source.latest(after, tuple(close_days))
            if grid is None:
                return None
            # A grid valid exactly at D+1@12:00:00Z (either product) belongs to convective day D.
            day = convective_day(grid.valid_at - timedelta(seconds=1))
            final = replace = grid.product == "1440min"
            try:
                contours = contour_grid(grid.path)
                shapes = split_storms(contours)
                rows = conn.execute(
                    "SELECT id, ST_AsBinary(geom_075), first_seen_at FROM storms "
                    "WHERE convective_day = %s AND merged_into IS NULL",
                    (day,),
                )
                existing = [(r[0], shapely.from_wkb(bytes(r[1])), r[2]) for r in rows.fetchall()]
                matched = match_existing(shapes, existing)
                return write_run(conn, grid, day, matched, final, replace)
            finally:
                grid.path.unlink(missing_ok=True)
        except Exception as err:
            conn.rollback()
            key = grid.key if grid is not None else "source"
            count = record_failure(conn, key, err)
            conn.commit()
            log.error("hail tick failed (%s in a row)", count)
            raise TickFailed(count) from err

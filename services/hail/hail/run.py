"""One tick: fetch the newest grid, contour it, group storms and write the run."""

import logging
from datetime import datetime, timedelta

import shapely

from hail.contours import contour_grid
from hail.source import HailSource
from hail.storms import match_existing, split_storms
from hail.units import convective_day
from hail.writer import RunSummary, last_processed_key, record_failure, write_run

log = logging.getLogger(__name__)


class TickFailed(Exception):
    def __init__(self, count: int):
        super().__init__("hail tick failed")
        self.count = count


def tick(source: HailSource, conn_factory, now: datetime) -> RunSummary | None:
    _ = now
    with conn_factory() as conn:
        grid = None
        try:
            after = last_processed_key(conn)
            grid = source.latest(after)
            if grid is None:
                return None
            final = grid.valid_at.hour == 12  # the 12Z grid closes the previous convective day
            day = convective_day(grid.valid_at)
            if final:
                day = day - timedelta(days=1)
            try:
                contours = contour_grid(grid.path)
                shapes = split_storms(contours)
                rows = conn.execute("SELECT id, ST_AsBinary(geom_075) FROM storms WHERE convective_day = %s", (day,))
                existing = [(row[0], shapely.from_wkb(bytes(row[1]))) for row in rows.fetchall()]
                matched = match_existing(shapes, existing)
                return write_run(conn, grid, day, matched, final)
            finally:
                grid.path.unlink(missing_ok=True)
        except Exception as err:
            conn.rollback()
            key = grid.key if grid is not None else "source"
            count = record_failure(conn, key, err)
            conn.commit()
            log.error("hail tick failed (%s in a row)", count)
            raise TickFailed(count) from err

"""Hail data sources."""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple, Protocol

import httpx

from hail.mesh import PREFIX_60, PREFIX_1440, download, list_keys, parse_valid_at
from hail.units import final_instant


class HailGrid(NamedTuple):
    valid_at: datetime
    key: str
    path: Path  # decompressed GRIB2 on disk
    product: str  # "60min" | "1440min"


class HailSource(Protocol):
    name: str

    def latest(self, after_key: str | None, close_days: tuple[date, ...] = ()) -> HailGrid | None:
        """The next grid to process, or None when nothing is new."""
        ...


class MeshSource:
    name = "mesh"

    def __init__(self, http: httpx.Client, workdir: Path, base_url: str = "https://noaa-mrms-pds.s3.amazonaws.com"):
        self.http = http
        self.workdir = workdir
        self.base_url = base_url

    def _closing_key(self, day: date, now: datetime | None = None) -> str | None:
        """The 1440min key that closes convective day `day`.

        The key valid exactly at D+1@12:00:00Z wins whenever it exists. Until 20 minutes past that instant we wait
        for it (None); after that the last key valid before it is accepted, as the exact key may never be published.
        """
        instant = final_instant(day)
        now = datetime.now(timezone.utc) if now is None else now
        keys = list_keys(self.http, self.base_url, instant.date(), PREFIX_1440)
        for k in keys:
            if parse_valid_at(k) == instant:
                return k
        if now < instant + timedelta(minutes=20):
            return None
        usable = [k for k in keys if parse_valid_at(k) <= instant]
        if not usable:
            return None
        usable.sort(key=parse_valid_at)
        return usable[-1]

    def _grid(self, key: str, product: str) -> HailGrid:
        path = download(self.http, self.base_url, key, self.workdir)
        return HailGrid(valid_at=parse_valid_at(key), key=key, path=path, product=product)

    def latest(self, after_key: str | None, close_days: tuple[date, ...] = ()) -> HailGrid | None:
        for day in sorted(close_days):
            key = self._closing_key(day)
            if key is not None:
                return self._grid(key, "1440min")
        now = datetime.now(timezone.utc)
        keys = sorted(
            list_keys(self.http, self.base_url, (now - timedelta(days=1)).date(), PREFIX_60)
            + list_keys(self.http, self.base_url, now.date(), PREFIX_60),
            key=parse_valid_at,
        )
        if not keys:
            return None
        if after_key is None:
            chosen = keys[-1]  # no history replay: start from the newest grid only
        else:
            floor = parse_valid_at(after_key)
            newer = [k for k in keys if parse_valid_at(k) > floor]
            if not newer:
                return None
            # Each 60min grid is a rolling 60-minute max, so the newest grid no more than 60 minutes past the
            # last processed one loses no hail; this keeps up with real time and steps an hour per tick after a gap.
            window = [k for k in newer if parse_valid_at(k) <= floor + timedelta(minutes=60)]
            chosen = window[-1] if window else newer[0]
        return self._grid(chosen, "60min")

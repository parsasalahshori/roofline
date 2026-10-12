"""Hail data sources."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple, Protocol

import httpx

from hail.mesh import download, list_keys, parse_valid_at


class HailGrid(NamedTuple):
    valid_at: datetime
    key: str
    path: Path  # decompressed GRIB2 on disk


class HailSource(Protocol):
    name: str

    def latest(self, after_key: str | None) -> HailGrid | None:
        """Newest grid after after_key, or None when nothing is new."""
        ...


class MeshSource:
    name = "mesh"

    def __init__(self, http: httpx.Client, workdir: Path, base_url: str = "https://noaa-mrms-pds.s3.amazonaws.com"):
        self.http = http
        self.workdir = workdir
        self.base_url = base_url

    def latest(self, after_key: str | None) -> HailGrid | None:
        now = datetime.now(timezone.utc)
        keys = sorted(
            list_keys(self.http, self.base_url, (now - timedelta(days=1)).date())
            + list_keys(self.http, self.base_url, now.date())
        )
        if not keys:
            return None
        newest = keys[-1]
        if after_key is not None and parse_valid_at(newest) <= parse_valid_at(after_key):
            return None
        path = download(self.http, self.base_url, newest, self.workdir)
        return HailGrid(valid_at=parse_valid_at(newest), key=newest, path=path)

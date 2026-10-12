from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from hail import source
from hail.source import MeshSource

DAY = date(2026, 6, 1)
INSTANT = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)


def key(hhmmss: str, day: str = "20260602") -> str:
    return f"CONUS/MESH_Max_1440min_00.50/{day}/MRMS_MESH_Max_1440min_00.50_{day}-{hhmmss}.grib2.gz"


def make(monkeypatch, keys):
    monkeypatch.setattr(source, "list_keys", lambda http, base, day, prefix=None: list(keys))
    return MeshSource(None, Path("x"))


def test_exact_key_returned_even_when_later_keys_exist(monkeypatch):
    src = make(monkeypatch, [key("115000"), key("120000"), key("121000")])
    assert src._closing_key(DAY, now=INSTANT + timedelta(minutes=1)) == key("120000")


def test_before_grace_with_only_earlier_key_waits(monkeypatch):
    src = make(monkeypatch, [key("115000")])
    assert src._closing_key(DAY, now=INSTANT + timedelta(minutes=19)) is None


def test_after_grace_falls_back_to_last_earlier_key(monkeypatch):
    src = make(monkeypatch, [key("114000"), key("115000"), key("121000")])
    assert src._closing_key(DAY, now=INSTANT + timedelta(minutes=20)) == key("115000")


def test_after_grace_without_usable_key_is_none(monkeypatch):
    src = make(monkeypatch, [key("121000")])
    assert src._closing_key(DAY, now=INSTANT + timedelta(hours=2)) is None

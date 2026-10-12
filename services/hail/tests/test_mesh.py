import gzip
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from hail.mesh import download, list_keys, parse_valid_at
from hail.source import HailGrid, MeshSource

FIXTURES = Path(__file__).parent / "fixtures"
NS = "http://s3.amazonaws.com/doc/2006-03-01/"
PREFIX_0528 = "CONUS/MESH_Max_1440min_00.50/20240528/MRMS_MESH_Max_1440min_00.50_"
KEY_NOON = f"{PREFIX_0528}20240528-120000.grib2.gz"


def page(keys: list[str]) -> str:
    contents = "".join(f"<Contents><Key>{k}</Key></Contents>" for k in keys)
    return f'<ListBucketResult xmlns="{NS}"><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>'


def test_parse_valid_at_with_and_without_mrms_prefix():
    noon = datetime(2024, 5, 28, 12, 0, 0, tzinfo=UTC)
    assert parse_valid_at(KEY_NOON) == noon
    assert parse_valid_at("MESH_Max_1440min_00.50_20240528-120000.grib2.gz") == noon
    assert parse_valid_at("MESH_Max_1440min_00.50_20240528-120000.grib2") == noon
    assert parse_valid_at(f"{PREFIX_0528}20240528-115959.grib2.gz") == datetime(2024, 5, 28, 11, 59, 59, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_valid_at("garbage")


def test_list_keys_parses_recorded_page():
    recorded = (FIXTURES / "list-20240528.xml").read_text()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "continuation-token" in request.url.params:
            return httpx.Response(200, text=page([]))
        return httpx.Response(200, text=recorded)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        keys = list_keys(client, "https://example.test", datetime(2024, 5, 28).date())

    expected = [f"{PREFIX_0528}20240528-{t}.grib2.gz" for t in ("000000", "003000", "010000", "013000")]
    assert keys == expected
    assert len(keys) == 4
    assert len(seen) == 2
    assert seen[0].url.params["list-type"] == "2"
    assert seen[0].url.params["prefix"] == "CONUS/MESH_Max_1440min_00.50/20240528/"


def test_download_gunzips(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/" + KEY_NOON
        return httpx.Response(200, content=gzip.compress(b"GRIB-bytes"))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        path = download(client, "https://example.test", KEY_NOON, tmp_path)

    assert path == tmp_path / "MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2"
    assert path.read_bytes() == b"GRIB-bytes"
    assert not (tmp_path / "MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2.gz").exists()


def test_mesh_source_latest(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if "list-type" in request.url.params:
            prefix = request.url.params["prefix"]
            day = prefix.rstrip("/").rsplit("/", 1)[-1]
            return httpx.Response(200, text=page([f"{prefix}MRMS_MESH_Max_1440min_00.50_{day}-120000.grib2.gz"]))
        return httpx.Response(200, content=gzip.compress(b"GRIB-bytes"))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        source = MeshSource(client, tmp_path, base_url="https://example.test")
        grid = source.latest(None)
        assert isinstance(grid, HailGrid)
        today = datetime.now(UTC).strftime("%Y%m%d")
        assert grid.key.endswith(f"MRMS_MESH_Max_1440min_00.50_{today}-120000.grib2.gz")
        assert grid.path.exists()
        assert source.latest(grid.key) is None

import gzip
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from hail.mesh import PREFIX_60, download, list_keys, parse_valid_at, product_of
from hail.source import HailGrid, MeshSource

FIXTURES = Path(__file__).parent / "fixtures"
NS = "http://s3.amazonaws.com/doc/2006-03-01/"
PREFIX_0528 = "CONUS/MESH_Max_1440min_00.50/20240528/MRMS_MESH_Max_1440min_00.50_"
KEY_NOON = f"{PREFIX_0528}20240528-120000.grib2.gz"


def page(keys: list[str]) -> str:
    contents = "".join(f"<Contents><Key>{k}</Key></Contents>" for k in keys)
    return f'<ListBucketResult xmlns="{NS}"><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>'


def test_parse_valid_at_with_and_without_mrms_prefix():
    noon = datetime(2024, 5, 28, 12, 0, 0, tzinfo=timezone.utc)
    assert parse_valid_at(KEY_NOON) == noon
    assert parse_valid_at("MESH_Max_1440min_00.50_20240528-120000.grib2.gz") == noon
    assert parse_valid_at("MESH_Max_1440min_00.50_20240528-120000.grib2") == noon
    assert parse_valid_at(f"{PREFIX_0528}20240528-115959.grib2.gz") == datetime(2024, 5, 28, 11, 59, 59, tzinfo=timezone.utc)
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
        keys = list_keys(client, "https://example.test", date(2024, 5, 28))

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


def key60(day: str, hhmmss: str) -> str:
    return f"{PREFIX_60}{day}/MRMS_MESH_Max_60min_00.50_{day}-{hhmmss}.grib2.gz"


def key1440(day: str, hhmmss: str) -> str:
    return f"CONUS/MESH_Max_1440min_00.50/{day}/MRMS_MESH_Max_1440min_00.50_{day}-{hhmmss}.grib2.gz"


def test_parse_valid_at_and_product_of_60min():
    key = key60("20240528", "000000")
    assert parse_valid_at(key) == datetime(2024, 5, 28, 0, 0, 0, tzinfo=timezone.utc)
    assert parse_valid_at("MESH_Max_60min_00.50_20240527-230000.grib2") == datetime(
        2024, 5, 27, 23, 0, 0, tzinfo=timezone.utc
    )
    assert product_of(key) == "60min"
    assert product_of(KEY_NOON) == "1440min"
    assert product_of("MESH_Max_60min_00.50_20240527-230000.grib2") == "60min"
    with pytest.raises(ValueError):
        product_of("MESH_Max_30min_00.50_20240527-230000.grib2")


def test_list_keys_with_60min_prefix():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=page([key60("20240528", "000000")]))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        keys = list_keys(client, "https://example.test", date(2024, 5, 28), prefix=PREFIX_60)
    assert keys == [key60("20240528", "000000")]
    assert seen[0].url.params["prefix"] == "CONUS/MESH_Max_60min_00.50/20240528/"


def listing_client(by_prefix: dict[str, list[str]], downloads: list[str]):
    """A mock bucket: listings keyed by exact prefix; every other request is a download."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "list-type" in request.url.params:
            return httpx.Response(200, text=page(by_prefix.get(request.url.params["prefix"], [])))
        downloads.append(request.url.path.lstrip("/"))
        return httpx.Response(200, content=gzip.compress(b"GRIB-bytes"))

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_mesh_source_latest_close_days_returns_1440min_noon(tmp_path):
    keys = [key1440("20240528", t) for t in ("110000", "120000", "123000")]
    downloads: list[str] = []
    with listing_client({"CONUS/MESH_Max_1440min_00.50/20240528/": keys}, downloads) as client:
        source = MeshSource(client, tmp_path, base_url="https://example.test")
        grid = source.latest(None, (date(2024, 5, 27),))
    assert isinstance(grid, HailGrid)
    assert grid.product == "1440min"
    assert grid.key == key1440("20240528", "120000")
    assert grid.valid_at == datetime(2024, 5, 28, 12, 0, 0, tzinfo=timezone.utc)
    assert grid.path.exists()
    assert downloads == [grid.key]


def test_mesh_source_close_day_takes_last_key_at_or_before_noon(tmp_path):
    keys = [key1440("20240528", t) for t in ("110000", "115800", "121000")]
    with listing_client({"CONUS/MESH_Max_1440min_00.50/20240528/": keys}, []) as client:
        source = MeshSource(client, tmp_path, base_url="https://example.test")
        grid = source.latest(None, (date(2024, 5, 27),))
    assert grid is not None
    assert grid.key == key1440("20240528", "115800")


def test_mesh_source_latest_takes_newest_grid_within_60_minutes(tmp_path):
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y%m%d")
    yesterday = (now - timedelta(days=1)).strftime("%Y%m%d")
    today_times = ("000000", "000200", "000400", "003000", "010000", "010200", "013000", "020000", "033000")
    keys = {
        f"{PREFIX_60}{yesterday}/": [key60(yesterday, "230000")],
        f"{PREFIX_60}{today}/": [key60(today, t) for t in today_times],
    }
    downloads: list[str] = []
    with listing_client(keys, downloads) as client:
        source = MeshSource(client, tmp_path, base_url="https://example.test")
        g = source.latest(None)
        assert g is not None and g.key == key60(today, "033000")
        assert g.product == "60min"
        g = source.latest(key60(yesterday, "220000"))
        assert g is not None and g.key == key60(yesterday, "230000")
        g = source.latest(key60(yesterday, "230000"))
        assert g is not None and g.key == key60(today, "000000")
        g = source.latest(key60(today, "000000"))
        assert g is not None and g.key == key60(today, "010000")
        g = source.latest(key60(today, "000200"))
        assert g is not None and g.key == key60(today, "010200")
        g = source.latest(key60(today, "010200"))
        assert g is not None and g.key == key60(today, "020000")
        g = source.latest(key60(today, "020000"))
        assert g is not None and g.key == key60(today, "033000")
        assert source.latest(key60(today, "033000")) is None
        assert source.latest(key60(today, "033000"), ()) is None


def test_mesh_source_close_day_missing_falls_through_to_60min(tmp_path):
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y%m%d")
    keys = {f"{PREFIX_60}{today}/": [key60(today, "000000")]}
    with listing_client(keys, []) as client:
        source = MeshSource(client, tmp_path, base_url="https://example.test")
        grid = source.latest(None, (date(2002, 6, 4),))
    assert grid is not None and grid.product == "60min"


def test_download_rejects_non_gz_key(tmp_path):
    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    key = "CONUS/MESH_Max_1440min_00.50/20240528/MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2"
    with pytest.raises(ValueError):
        download(http, "http://x", key, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_download_leaves_no_part_file_on_success(tmp_path):
    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=gzip.compress(b"abc"))))
    result = download(http, "http://x", KEY_NOON, tmp_path)
    assert result.read_bytes() == b"abc"
    assert list(tmp_path.glob("*.part")) == []

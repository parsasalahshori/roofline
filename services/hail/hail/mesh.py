"""NOAA MRMS MESH listing and download helpers (stdlib + httpx only)."""

import gzip
import re
import shutil
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

import httpx

S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
PREFIX = "CONUS/MESH_Max_1440min_00.50/"
_NAME_RE = re.compile(r"^(?:MRMS_)?MESH_Max_1440min_00\.50_(\d{8})-(\d{6})\.grib2(?:\.gz)?$")


def list_keys(http: httpx.Client, base_url: str, day: date) -> list[str]:
    """List every MESH key for one UTC day, following S3 continuation tokens."""
    params = {"list-type": "2", "prefix": f"{PREFIX}{day:%Y%m%d}/"}
    keys: list[str] = []
    while True:
        resp = http.get(f"{base_url}/", params=params)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        for key in root.findall(f"{S3_NS}Contents/{S3_NS}Key"):
            if key.text:
                keys.append(key.text)
        truncated = root.findtext(f"{S3_NS}IsTruncated")
        token = root.findtext(f"{S3_NS}NextContinuationToken")
        if truncated != "true" or not token:
            break
        params = {**params, "continuation-token": token}
    return sorted(keys)


def parse_valid_at(key: str) -> datetime:
    """Valid time (UTC) encoded in a MESH key or file name."""
    name = key.rsplit("/", 1)[-1]
    match = _NAME_RE.match(name)
    if match is None:
        raise ValueError(f"not a MESH file name: {key}")
    return datetime.strptime(f"{match.group(1)}{match.group(2)}", "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def download(http: httpx.Client, base_url: str, key: str, workdir: Path) -> Path:
    """Download a gzipped GRIB2 key into workdir and gunzip it; returns the .grib2 path."""
    if not key.endswith(".gz"):
        raise ValueError(f"not a gzipped MESH key: {key}")
    workdir.mkdir(parents=True, exist_ok=True)
    name = key.rsplit("/", 1)[-1]
    gz_path = workdir / name
    part = gz_path.with_name(gz_path.name + ".part")
    try:
        with http.stream("GET", f"{base_url}/{key}") as resp:
            resp.raise_for_status()
            with part.open("wb") as out:
                for chunk in resp.iter_bytes():
                    out.write(chunk)
        part.replace(gz_path)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    grib_path = workdir / name.removesuffix(".gz")
    grib_part = grib_path.with_name(grib_path.name + ".part")
    try:
        with gzip.open(gz_path, "rb") as src, grib_part.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        grib_part.replace(grib_path)
    except BaseException:
        grib_part.unlink(missing_ok=True)
        raise
    gz_path.unlink()
    return grib_path

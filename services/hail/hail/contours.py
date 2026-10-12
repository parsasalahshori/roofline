"""Turn an MRMS MESH GRIB2 grid into nested hail-size contour polygons (EPSG:4326)."""

from pathlib import Path
from typing import NamedTuple

import shapely
from osgeo import gdal, ogr, osr
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from hail.units import HAIL_LEVELS_IN, MM_PER_IN

gdal.UseExceptions()
osr.UseExceptions()

NODATA = -9999.0


class Contour(NamedTuple):
    threshold_in: float
    geom: MultiPolygon


def _srs(epsg: int) -> osr.SpatialReference:
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(epsg)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def reproject(geom: BaseGeometry, src_epsg: int, dst_epsg: int) -> BaseGeometry:
    ct = osr.CoordinateTransformation(_srs(src_epsg), _srs(dst_epsg))
    og = ogr.CreateGeometryFromWkb(geom.wkb)
    og.Transform(ct)
    return shapely.from_wkb(bytes(og.ExportToWkb()))


def _polygons(geom: BaseGeometry) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    parts: list[Polygon] = []
    for part in getattr(geom, "geoms", []):
        parts.extend(_polygons(part))
    return parts


def contour_grid(
    path: Path,
    levels_in: tuple[float, ...] = HAIL_LEVELS_IN,
    simplify_m: float = 30,
    min_area_km2: float = 0.1,
) -> list[Contour]:
    src = gdal.Open(str(path))
    band = src.GetRasterBand(1)
    arr = band.ReadAsArray().astype("float32")
    gt = list(src.GetGeoTransform())
    if gt[0] > 180:
        gt[0] -= 360
    arr[arr <= 0] = NODATA
    nrows, ncols = arr.shape

    mem = gdal.GetDriverByName("MEM").Create("", ncols, nrows, 1, gdal.GDT_Float32)
    mem.SetGeoTransform(gt)
    mem.SetProjection(_srs(4326).ExportToWkt())
    mem_band = mem.GetRasterBand(1)
    mem_band.WriteArray(arr)
    mem_band.SetNoDataValue(NODATA)

    levels_mm = [lv * MM_PER_IN for lv in levels_in]
    vds = ogr.GetDriverByName("Memory").CreateDataSource("c")
    layer = vds.CreateLayer("c", srs=_srs(4326), geom_type=ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("ID", ogr.OFTInteger))
    layer.CreateField(ogr.FieldDefn("ELEV_MIN", ogr.OFTReal))
    layer.CreateField(ogr.FieldDefn("ELEV_MAX", ogr.OFTReal))
    gdal.ContourGenerateEx(
        mem_band,
        layer,
        options=[
            "FIXED_LEVELS=" + ",".join(repr(x) for x in levels_mm),
            "POLYGONIZE=YES",
            "ID_FIELD=0",
            "ELEV_FIELD_MIN=1",
            "ELEV_FIELD_MAX=2",
            "NODATA=-9999",
        ],
    )

    bands: list[tuple[float, BaseGeometry]] = []
    for feat in layer:
        lo = feat.GetField("ELEV_MIN")
        ref = feat.GetGeometryRef()
        if lo is None or ref is None:
            continue
        bands.append((lo, shapely.from_wkb(bytes(ref.ExportToWkb()))))

    out: list[Contour] = []
    for lvl_in, lvl_mm in zip(levels_in, levels_mm, strict=True):
        geoms = [g for lo, g in bands if lo >= lvl_mm - 1e-6 and not g.is_empty]
        if not geoms:
            continue
        union = shapely.union_all(geoms)
        if union.is_empty:
            continue
        projected = reproject(union, 4326, 5070).simplify(simplify_m, preserve_topology=True)
        kept = [p for p in _polygons(projected) if p.area >= min_area_km2 * 1e6]
        if not kept:
            continue
        back = reproject(MultiPolygon(kept), 5070, 4326)
        polys = _polygons(back)
        if not polys:
            continue
        out.append(Contour(float(lvl_in), MultiPolygon(polys)))

    layer = None
    vds = None
    mem_band = None
    mem = None
    band = None
    src = None
    return out

"""Split a day's hail contours into storms and match them to stored storms."""

from typing import NamedTuple
from uuid import UUID

from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from hail.contours import Contour

FOOTPRINT_IN = 0.75


class StormShape(NamedTuple):
    footprint: MultiPolygon
    contours: dict[float, MultiPolygon]
    max_in: float


def _polygons(geom: BaseGeometry) -> list[Polygon]:
    if isinstance(geom, Polygon):
        return [geom] if not geom.is_empty and geom.area > 0 else []
    parts = getattr(geom, "geoms", None)
    if parts is None:
        return []
    out: list[Polygon] = []
    for part in parts:
        out.extend(_polygons(part))
    return out


def _as_multi(geom: BaseGeometry) -> MultiPolygon:
    """Polygon parts of any geometry as a MultiPolygon (empty when there are none)."""
    polys = _polygons(geom)
    return MultiPolygon(polys) if polys else MultiPolygon()


def split_storms(contours: list[Contour]) -> list[StormShape]:
    base = next((c for c in contours if abs(c.threshold_in - FOOTPRINT_IN) < 1e-9), None)
    if base is None or base.geom.is_empty:
        return []
    shapes: list[StormShape] = []
    for poly in base.geom.geoms:
        clipped_by_level: dict[float, MultiPolygon] = {}
        for c in contours:
            clipped = _as_multi(c.geom.intersection(poly))
            if not clipped.is_empty:
                clipped_by_level[c.threshold_in] = clipped
        if not clipped_by_level:
            continue
        shapes.append(StormShape(MultiPolygon([poly]), clipped_by_level, max(clipped_by_level)))
    shapes.sort(key=lambda s: s.footprint.area, reverse=True)
    return shapes


def match_existing(
    shapes: list[StormShape], existing: list[tuple[UUID, MultiPolygon]]
) -> list[tuple[UUID | None, StormShape]]:
    triples: list[tuple[float, int, int]] = []
    for si, shape in enumerate(shapes):
        for ei, (_, geom) in enumerate(existing):
            area = shape.footprint.intersection(geom).area
            if area > 0:
                triples.append((area, si, ei))
    triples.sort(key=lambda t: (-t[0], t[1], t[2]))
    used_shapes: set[int] = set()
    used_existing: set[int] = set()
    assigned: dict[int, UUID] = {}
    for _, si, ei in triples:
        if si in used_shapes or ei in used_existing:
            continue
        used_shapes.add(si)
        used_existing.add(ei)
        assigned[si] = existing[ei][0]
    return [(assigned.get(i), shape) for i, shape in enumerate(shapes)]

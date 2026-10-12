"""Split a day's hail contours into storms and match them to stored storms."""

from datetime import datetime
from typing import NamedTuple
from uuid import UUID

from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

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


class Match(NamedTuple):
    storm_id: UUID | None
    shape: StormShape
    merged_ids: list[UUID]


def _merge_shapes(shapes: list[StormShape]) -> StormShape:
    if len(shapes) == 1:
        return shapes[0]
    footprint = _as_multi(unary_union([s.footprint for s in shapes]))
    levels: dict[float, list[BaseGeometry]] = {}
    for s in shapes:
        for threshold, geom in s.contours.items():
            levels.setdefault(threshold, []).append(geom)
    contours = {t: _as_multi(unary_union(geoms)) for t, geoms in sorted(levels.items())}
    return StormShape(footprint, contours, max(s.max_in for s in shapes))


def match_existing(
    shapes: list[StormShape], existing: list[tuple[UUID, MultiPolygon, datetime]]
) -> list[Match]:
    """Group shapes and stored storms into overlap components; the oldest stored storm keeps its id."""
    n = len(shapes)
    parent = list(range(n + len(existing)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for si, shape in enumerate(shapes):
        for ei, (_, geom, _) in enumerate(existing):
            if shape.footprint.intersection(geom).area > 0:
                parent[find(si)] = find(n + ei)

    groups: dict[int, tuple[list[int], list[int]]] = {}
    for si in range(n):
        groups.setdefault(find(si), ([], []))[0].append(si)
    for ei in range(len(existing)):
        root = find(n + ei)
        if root in groups:  # stored storms that overlap no shape are left alone
            groups[root][1].append(ei)

    matches: list[Match] = []
    for shape_idx, exist_idx in groups.values():
        merged = _merge_shapes([shapes[i] for i in shape_idx])
        ordered = sorted(exist_idx, key=lambda e: (existing[e][2], str(existing[e][0])))
        if ordered:
            matches.append(Match(existing[ordered[0]][0], merged, [existing[e][0] for e in ordered[1:]]))
        else:
            matches.append(Match(None, merged, []))
    matches.sort(key=lambda m: m.shape.footprint.area, reverse=True)
    return matches

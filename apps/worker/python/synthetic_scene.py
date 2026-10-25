"""A synthetic window scan to check the COLMAP refinement against a known truth.

Renders a few JPEGs of a textured brick wall with a recessed window (and a sill) from ARKit-style camera poses, writes
the frames (ARKit poses with a little tracking noise, as a phone would report them), the corner marks (the true corners
projected into every frame plus pixel noise) and the truth. numpy + Pillow only.

World = ARKit's: metres, +Y up, the wall is the plane z = 0 facing +z, cameras stand at z > 0 and look along their own -z.
Images are drawn at half the native size (960 x 720 for 1920 x 1440 intrinsics) on purpose: that exercises the
"scale the intrinsics to the picture" rule of docs/windows/scan-contract.md.

    python synthetic_scene.py --out DIR [--seed 7] [--no-noise] [--skew 0.05]

`--skew` moves the bottom-right corner of the opening by that many metres (right and up), so the window really is not a rectangle:
a scan that no amount of refining can make pass (the reviewer's screen needs one that stays open).
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import numpy as np
from PIL import Image

M_PER_IN = 0.0254
NATIVE = {"fx": 1500.0, "fy": 1500.0, "cx": 960.0, "cy": 720.0, "width": 1920, "height": 1440}
IMG_W, IMG_H = 960, 720  # the default picture size; `--full` draws the native 1920 x 1440 instead


def look_at(eye, target):
    """ARKit camera-to-world, column-major 16 numbers: looks along its -z, +x right, +y up."""
    eye = np.asarray(eye, float)
    f = np.asarray(target, float) - eye
    f /= np.linalg.norm(f)
    z = -f
    x = np.cross(f, [0.0, 1.0, 0.0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, eye
    return m


def to_column_major(m):
    return [float(v) for v in m.T.reshape(-1)]


def from_column_major(a):
    return np.asarray(a, float).reshape(4, 4).T


def _hash(ix, iy, seed):
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def value_noise(x, y, seed):
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(x, y, seed, octaves=5):
    total, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * value_noise(x * freq, y * freq, seed + o * 17)
        norm += amp
        amp *= 0.55
        freq *= 2.1
    return total / norm


def brick_texture(x, y):
    """Red-brown bricks 0.215 x 0.065 m with mortar and a lot of fine texture: plenty for SIFT."""
    row = np.floor(y / 0.075)
    xs = x + (row % 2) * 0.1075
    col = np.floor(xs / 0.225)
    u = (xs / 0.225) - col
    v = (y / 0.075) - row
    tone = 0.55 + 0.45 * _hash(col, row, 3)
    base = np.stack([150 + 70 * tone, 70 + 40 * tone, 52 + 30 * tone], -1)
    mortar = (u < 0.045) | (v < 0.08)
    grit = fbm(x * 90, y * 90, 11)[..., None]
    col_rgb = np.where(mortar[..., None], np.array([188.0, 184.0, 172.0]), base)
    return np.clip(col_rgb * (0.7 + 0.6 * grit) * (0.9 + 0.2 * fbm(x * 6, y * 6, 5)[..., None]), 0, 255)


def pane_texture(x, y):
    """Behind the glass: a curtain with stripes and folds, darker than the wall."""
    stripes = 0.5 + 0.5 * np.sin(x * 55 + 4 * fbm(x * 3, y * 3, 21))
    fold = fbm(x * 14, y * 5, 23)
    tone = 0.35 + 0.4 * stripes * (0.5 + 0.5 * fold)
    return np.clip(np.stack([95 * tone + 40, 110 * tone + 55, 150 * tone + 70], -1) + 25 * fbm(x * 60, y * 60, 29)[..., None], 0, 255)


def wood_texture(x, y):
    grain = 0.5 + 0.5 * np.sin(x * 140 + 6 * fbm(x * 10, y * 40, 31))
    return np.clip(np.stack([170 + 40 * grain, 130 + 30 * grain, 90 + 20 * grain], -1), 0, 255)


class Scene:
    def __init__(self, width_in=34.625, height_in=55.75, center=(0.0, 1.45), recess=0.10, skew=0.0):
        self.width_in, self.height_in = width_in, height_in
        self.skew = skew
        self.w, self.h = width_in * M_PER_IN, height_in * M_PER_IN
        self.cx, self.cy = center
        self.recess = recess
        self.x0, self.x1 = self.cx - self.w / 2, self.cx + self.w / 2
        self.y0, self.y1 = self.cy - self.h / 2, self.cy + self.h / 2
        # The sill: a slab under the window that sticks out 7 cm
        self.sill = (self.x0 - 0.04, self.x1 + 0.04, self.y0 - 0.045, self.y0, 0.0, 0.07)

    @property
    def corners(self):
        """TL, TR, BR, BL of the opening in the wall plane (z = 0); `skew` moves the bottom right one right and up."""
        return np.array([[self.x0, self.y1, 0.0], [self.x1, self.y1, 0.0], [self.x1 + self.skew, self.y0 + self.skew, 0.0], [self.x0, self.y0, 0.0]])

    def inside(self, x, y):
        """Whether (x, y) on the wall is inside the opening (a convex quad: every edge has the point on its right)."""
        c = self.corners
        ok = np.ones(np.shape(x), bool)
        for i in range(4):
            a, b = c[i], c[(i + 1) % 4]
            ok &= ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) <= 0
        return ok

    def render(self, cam_to_world, ss=2, size=(IMG_W, IMG_H)):
        """RGB uint8 (h, w, 3) of the scene from the camera, ss x ss supersampled."""
        k = NATIVE
        img_w, img_h = size
        sx, sy = k["width"] / img_w, k["height"] / img_h
        n = img_w * ss, img_h * ss
        px = (np.arange(n[0]) + 0.5) / ss
        py = (np.arange(n[1]) + 0.5) / ss
        gx, gy = np.meshgrid(px * sx, py * sy)
        d_cam = np.stack([(gx - k["cx"]) / k["fx"], -(gy - k["cy"]) / k["fy"], -np.ones_like(gx)], -1)
        r = cam_to_world[:3, :3]
        d = d_cam @ r.T
        o = cam_to_world[:3, 3]
        img = np.zeros(d.shape, float)
        tbest = np.full(d.shape[:2], np.inf)
        dz = d[..., 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            t_wall = np.where(dz < 0, (0.0 - o[2]) / dz, np.inf)
        hx, hy = o[0] + d[..., 0] * t_wall, o[1] + d[..., 1] * t_wall
        in_open = self.inside(hx, hy)
        # wall
        wall = ~in_open & np.isfinite(t_wall) & (t_wall > 0)
        img[wall] = brick_texture(hx[wall], hy[wall])
        tbest[wall] = t_wall[wall]
        # the pane / the reveal behind the opening
        with np.errstate(divide="ignore", invalid="ignore"):
            t_pane = np.where(dz < 0, (-self.recess - o[2]) / dz, np.inf)
        qx, qy = o[0] + d[..., 0] * t_pane, o[1] + d[..., 1] * t_pane
        pane_ok = in_open & (t_pane > 0) & self.inside(qx, qy)
        img[pane_ok] = pane_texture(qx[pane_ok], qy[pane_ok])
        tbest[pane_ok] = t_pane[pane_ok]
        reveal = in_open & ~pane_ok & (t_wall > 0)
        img[reveal] = np.array([205.0, 200.0, 190.0]) * (0.75 + 0.25 * fbm(hx[reveal] * 30, hy[reveal] * 30, 41)[..., None])
        tbest[reveal] = t_wall[reveal] + 0.05
        # the sill (axis-aligned box): slab test
        lo = np.array([self.sill[0], self.sill[2], self.sill[4]])
        hi = np.array([self.sill[1], self.sill[3], self.sill[5]])
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (lo - o) / d, (hi - o) / d
        tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
        sill_hit = (tmax >= tmin) & (tmax > 0)
        t_sill = np.where(tmin > 0, tmin, tmax)
        closer = sill_hit & (t_sill < tbest)
        if closer.any():
            p = o + d[closer] * t_sill[closer][..., None]
            img[closer] = wood_texture(p[:, 0] + 0.3 * p[:, 2], p[:, 1] * 0.2 + p[:, 2])
            tbest[closer] = t_sill[closer]
        # a soft light fall-off so the exposure is not flat
        img *= (0.92 + 0.08 * fbm(hx * 1.3, hy * 1.3, 77)[..., None])
        # box downsample
        img = img.reshape(img_h, ss, img_w, ss, 3).mean(axis=(1, 3))
        return np.clip(img, 0, 255).astype(np.uint8)


def project(p_world, cam_to_world, k=NATIVE):
    """Native pixels of a world point, the contract's formula (None when not in front of the camera)."""
    inv = np.linalg.inv(cam_to_world)
    c = inv[:3, :3] @ p_world + inv[:3, 3]
    if not c[2] < -1e-4:
        return None
    return [k["cx"] + k["fx"] * c[0] / -c[2], k["cy"] - k["fy"] * c[1] / -c[2]]


def default_cameras(scene: Scene):
    """Five regular frames (spread in all three directions, not on a line) and three corner close-ups."""
    target = [scene.cx, scene.cy, 0.0]
    regular = [(-1.5, 1.15, 2.6), (-0.7, 1.75, 2.9), (0.1, 1.35, 2.4), (0.85, 1.85, 3.0), (1.55, 1.2, 2.7)]
    cams = [(f"r{i + 1}", "regular", None, np.array(e), target) for i, e in enumerate(regular)]
    corners = scene.corners
    for i, c in enumerate([0, 2, 3]):
        p = corners[c]
        sx = -0.22 if c in (0, 3) else 0.22
        sy = 0.16 if c in (0, 1) else -0.16
        cams.append((f"c{i + 1}", "closeup", c, np.array([p[0] + sx, p[1] + sy, 1.0]), list(p)))
    return cams


def build(out_dir: Path, seed=7, noise=True, width_in=34.625, height_in=55.75, skew=0.0, full=False):
    rng = np.random.default_rng(seed)
    scene = Scene(width_in, height_in, skew=skew)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "images").mkdir(exist_ok=True)
    size, ss = ((NATIVE["width"], NATIVE["height"]), 1) if full else ((IMG_W, IMG_H), 2)
    frames, marks, truth_frames = [], [], {}
    for frame_id, kind, corner, eye, target in default_cameras(scene):
        true_pose = look_at(eye, target)
        Image.fromarray(scene.render(true_pose, ss=ss, size=size)).save(out_dir / "images" / f"{frame_id}.jpg", quality=92)
        # What the phone reports: the true pose with tracking noise (3 mm, 0.05 degrees)
        reported = true_pose.copy()
        if noise:
            reported[:3, 3] += rng.normal(0, 0.003, 3)
            ang = math.radians(0.05) * rng.normal(0, 1, 3)
            reported[:3, :3] = _rodrigues(ang) @ reported[:3, :3]
        frames.append(
            {
                "frameId": frame_id,
                "kind": kind,
                "corner": corner,
                "path": f"images/{frame_id}.jpg",
                "imageWidth": size[0],
                "imageHeight": size[1],
                "cameraTransform": to_column_major(reported),
                "intrinsics": dict(NATIVE),
            }
        )
        truth_frames[frame_id] = to_column_major(true_pose)
        for c in range(4):
            if kind == "closeup" and c != corner:
                continue
            p = project(scene.corners[c], true_pose)
            if p is None or not (0 <= p[0] <= NATIVE["width"] and 0 <= p[1] <= NATIVE["height"]):
                continue
            jitter = rng.uniform(-0.8, 0.8, 2) if noise else np.zeros(2)
            marks.append({"frameId": frame_id, "corner": c, "x": round(p[0] + jitter[0], 2), "y": round(p[1] + jitter[1], 2), "source": "snap"})
    data = {
        "frames": frames,
        "marks": marks,
        "wall": {"point": [scene.cx, scene.cy, 0.0], "normal": [0, 0, 1]},
        "truth": {"cornersM": scene.corners.tolist(), "widthIn": width_in, "heightIn": height_in, "poses": truth_frames},
    }
    (out_dir / "scene.json").write_text(json.dumps(data, indent=1))
    return data


def _rodrigues(w):
    th = np.linalg.norm(w)
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * kx + (1 - math.cos(th)) * kx @ kx


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-noise", action="store_true")
    ap.add_argument("--skew", type=float, default=0.0)
    ap.add_argument("--full", action="store_true", help="draw the pictures at the native 1920 x 1440 (the default is half that)")
    a = ap.parse_args()
    d = build(Path(a.out), seed=a.seed, noise=not a.no_noise, skew=a.skew, full=a.full)
    print(f"wrote {len(d['frames'])} frames, {len(d['marks'])} marks to {os.path.abspath(a.out)}")

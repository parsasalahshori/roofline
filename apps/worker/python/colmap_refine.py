"""Rebuild a window scan's 3D from its photos with COLMAP and put it back in ARKit's world.

Called by the `scan-refine` job (apps/api/src/scans/refine/colmap.ts) with the venv python:

    python colmap_refine.py --input in.json --output out.json
    python colmap_refine.py --selftest                       # the maths only, no COLMAP needed

Input (JSON): { "images": [ { "frameId", "path", "imageWidth", "imageHeight", "intrinsics": {fx, fy, cx, cy, width, height},
                              "cameraTransform": [16 numbers, ARKit camera-to-world, column-major] } ],
                "workDir": "...", "plyPath": "... .ply" (optional), "options": { "maxImageSize": 1600, ... } }

What it does (docs/windows/scan-contract.md, "Refinement"):
  1. SIFT features and exhaustive matching on every photo, with each camera's intrinsics KNOWN and held fixed: a PINHOLE camera
     from fx, fy, cx, cy scaled by (image size / intrinsics size), because the uploaded JPEG may be a resized copy of the
     native image the intrinsics describe.
  2. Incremental mapping (bundle adjustment with the intrinsics constant). The biggest model wins.
  3. The model is in COLMAP's own, unscaled frame. A similarity transform (Umeyama on the camera centres; when the centres lie
     on one line the rotation comes from the camera orientations instead) puts it in ARKit's world, in metres. The alignment's
     RMS over the camera centres says how far to trust it.
  4. The aligned poses are written as ARKit camera-to-world transforms, and the aligned sparse points as a PLY.

Conventions (the part that is easy to get wrong):
  ARKit camera:  +x right, +y up, looks along -z.   `cameraTransform` = camera-to-world.
  COLMAP camera: +x right, +y DOWN, looks along +z. `image.cam_from_world` = world-to-camera.
  The same camera in both: p_colmap_cam = D p_arkit_cam with D = diag(1, -1, -1).
  So  cam_from_world (COLMAP) = D * inverse(cameraTransform (ARKit)),  and  cameraTransform = inverse(cam_from_world) * D.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

D_FLIP = np.diag([1.0, -1.0, -1.0])

# ---------------------------------------------------------------------------------------------------------------------
# Conventions and the similarity transform (pure numpy: tested by --selftest and by the synthetic check)
# ---------------------------------------------------------------------------------------------------------------------


def column_major_to_matrix(a) -> np.ndarray:
    """16 column-major numbers (simd layout: translation = m[12..14]) to a 4x4 row-major matrix."""
    return np.asarray(a, float).reshape(4, 4).T.copy()


def matrix_to_column_major(m: np.ndarray) -> list[float]:
    return [float(v) for v in np.asarray(m, float).T.reshape(-1)]


def arkit_to_cam_from_world(camera_transform) -> tuple[np.ndarray, np.ndarray]:
    """ARKit camera-to-world (16 column-major numbers) to COLMAP's world-to-camera rotation and translation."""
    t_wc = column_major_to_matrix(camera_transform)
    r_wc, c = t_wc[:3, :3], t_wc[:3, 3]
    r_cw_arkit = r_wc.T
    t_cw_arkit = -r_wc.T @ c
    return D_FLIP @ r_cw_arkit, D_FLIP @ t_cw_arkit


def cam_from_world_to_arkit(r_cw: np.ndarray, t_cw: np.ndarray) -> np.ndarray:
    """COLMAP's world-to-camera (R, t) to an ARKit-style camera-to-world 4x4 (still in COLMAP's world)."""
    r_wc = r_cw.T @ D_FLIP
    c = -r_cw.T @ t_cw
    m = np.eye(4)
    m[:3, :3] = r_wc
    m[:3, 3] = c
    return m


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool = True):
    """Least-squares similarity dst ~ s R src + t (Umeyama 1991). Returns (s, R, t); R is a proper rotation."""
    n = len(src)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / n
    u, sv, vt = np.linalg.svd(cov)
    sign = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[2, 2] = -1.0
    r = u @ sign @ vt
    var_s = (xs**2).sum() / n
    s = float(np.trace(np.diag(sv) @ sign) / var_s) if with_scale and var_s > 0 else 1.0
    t = mu_d - s * r @ mu_s
    return s, r, t


def centre_spread(points: np.ndarray) -> float:
    """Second singular value over the first of the centred points: 0 when they are on a line, towards 1 when spread in a plane."""
    xs = points - points.mean(0)
    sv = np.linalg.svd(xs, compute_uv=False)
    return float(sv[1] / sv[0]) if sv[0] > 1e-12 else 0.0


def rotation_mean(rotations: list[np.ndarray]) -> np.ndarray:
    """The chordal L2 mean of rotations: the rotation nearest to their sum."""
    m = sum(rotations)
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def rotation_angle_deg(r: np.ndarray) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2))))


def align_to_arkit(colmap_poses: dict, arkit_poses: dict, min_spread: float = 0.12) -> dict:
    """Similarity from COLMAP's frame to ARKit's world from the cameras both have.

    `colmap_poses[id]` is a camera-to-world 4x4 (ARKit camera axes, COLMAP's world) from `cam_from_world_to_arkit`;
    `arkit_poses[id]` is the phone's camera-to-world 4x4. Returns scale, rotation, translation, how the rotation was found
    ('centres' | 'orientations'), the residual of every camera centre (metres) and of every camera's orientation (degrees).
    """
    ids = [i for i in colmap_poses if i in arkit_poses]
    src = np.array([colmap_poses[i][:3, 3] for i in ids])
    dst = np.array([arkit_poses[i][:3, 3] for i in ids])
    spread = centre_spread(src) if len(ids) >= 3 else 0.0
    if spread >= min_spread:
        s, r, t = umeyama(src, dst)
        method = "centres"
    else:
        # The centres lie (nearly) on a line: a turn round that line cannot be seen in them. The cameras' orientations fix it.
        r = rotation_mean([arkit_poses[i][:3, :3] @ colmap_poses[i][:3, :3].T for i in ids])
        xs, xd = src - src.mean(0), dst - dst.mean(0)
        rot_xs = xs @ r.T
        s = float((xd * rot_xs).sum() / max((xs**2).sum(), 1e-12))
        t = dst.mean(0) - s * r @ src.mean(0)
        method = "orientations"
    centre_res = {}
    rot_res = {}
    for i in ids:
        c = s * r @ colmap_poses[i][:3, 3] + t
        centre_res[i] = float(np.linalg.norm(c - arkit_poses[i][:3, 3]))
        rot_res[i] = rotation_angle_deg((r @ colmap_poses[i][:3, :3]) @ arkit_poses[i][:3, :3].T)
    return {"scale": s, "rotation": r, "translation": t, "method": method, "spread": spread, "centreResidualM": centre_res, "rotationResidualDeg": rot_res}


def transform_pose(c2w: np.ndarray, s: float, r: np.ndarray, t: np.ndarray) -> np.ndarray:
    """A camera-to-world pose carried through x -> s R x + t (its orientation is turned, its centre moved and scaled)."""
    out = np.eye(4)
    out[:3, :3] = r @ c2w[:3, :3]
    out[:3, 3] = s * r @ c2w[:3, 3] + t
    return out


# ---------------------------------------------------------------------------------------------------------------------
# COLMAP
# ---------------------------------------------------------------------------------------------------------------------


def run_colmap(images: list[dict], work: Path, opts: dict) -> dict:
    """Feature extraction, matching and mapping with known, fixed intrinsics. Returns the best model's poses and points."""
    import pycolmap

    try:  # COLMAP logs a line per step; the job only wants the JSON answer, so keep warnings and errors
        pycolmap.logging.minloglevel = 1
    except Exception:  # noqa: BLE001 - a different pycolmap without this switch is fine
        pass
    work.mkdir(parents=True, exist_ok=True)
    db = work / "database.db"
    if db.exists():
        db.unlink()
    sparse = work / "sparse"
    sparse.mkdir(exist_ok=True)
    img_dir = work / "images"
    img_dir.mkdir(exist_ok=True)
    names = {}
    for im in images:
        link = img_dir / f"{im['frameId']}{Path(im['path']).suffix or '.jpg'}"
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(Path(im["path"]).resolve())
        names[link.name] = im["frameId"]

    timings = {}
    t0 = time.time()
    ext = pycolmap.FeatureExtractionOptions()
    ext.max_image_size = int(opts.get("maxImageSize", 1600))
    ext.sift.max_num_features = int(opts.get("maxFeatures", 8192))
    for im in images:
        k = im["intrinsics"]
        sx, sy = im["imageWidth"] / k["width"], im["imageHeight"] / k["height"]
        reader = pycolmap.ImageReaderOptions()
        reader.camera_model = "PINHOLE"
        reader.camera_params = f"{k['fx'] * sx:.6f},{k['fy'] * sy:.6f},{k['cx'] * sx:.6f},{k['cy'] * sy:.6f}"
        name = f"{im['frameId']}{Path(im['path']).suffix or '.jpg'}"
        pycolmap.extract_features(db, img_dir, image_names=[name], camera_mode=pycolmap.CameraMode.PER_IMAGE, reader_options=reader, extraction_options=ext, device=pycolmap.Device.cpu)
    timings["extract"] = time.time() - t0

    t0 = time.time()
    pycolmap.match_exhaustive(db, device=pycolmap.Device.cpu)
    timings["match"] = time.time() - t0

    t0 = time.time()
    po = pycolmap.IncrementalPipelineOptions()
    po.min_model_size = int(opts.get("minModelSize", 3))
    po.multiple_models = False
    po.ba_refine_focal_length = False
    po.ba_refine_principal_point = False
    po.ba_refine_extra_params = False
    po.mapper.abs_pose_refine_focal_length = False
    po.mapper.abs_pose_refine_extra_params = False
    po.mapper.init_min_tri_angle = float(opts.get("initMinTriAngle", 4.0))
    po.mapper.init_min_num_inliers = int(opts.get("initMinInliers", 60))
    po.mapper.abs_pose_min_num_inliers = int(opts.get("absPoseMinInliers", 20))
    po.mapper.ba_local_min_tri_angle = 2.0
    po.mapper.filter_max_reproj_error = float(opts.get("filterReprojPx", 3.0))
    po.mapper.random_seed = 0
    po.random_seed = 0
    po.num_threads = int(opts.get("threads", -1))
    models = pycolmap.incremental_mapping(db, img_dir, sparse, po)
    timings["map"] = time.time() - t0
    if not models:
        return {"ok": False, "reason": "no_model", "timings": timings, "detail": "COLMAP could not start a reconstruction (too few matches between the photos)."}
    best = max(models.values(), key=lambda m: m.num_reg_images())

    poses = {}
    for image_id, image in best.images.items():
        if not image.has_pose:
            continue
        cfw = image.cam_from_world()
        r_cw = np.asarray(cfw.rotation.matrix(), float)
        t_cw = np.asarray(cfw.translation, float)
        poses[names[image.name]] = {"c2w": cam_from_world_to_arkit(r_cw, t_cw), "numPoints": int(image.num_points3D)}
    pts = []
    for p in best.points3D.values():
        pts.append((np.asarray(p.xyz, float), np.asarray(p.color, float), float(p.error), len(p.track.elements)))
    errors = [p[2] for p in pts]
    return {
        "ok": True,
        "poses": poses,
        "points": pts,
        "timings": timings,
        "model": {
            "images": int(best.num_reg_images()),
            "points": len(pts),
            "meanReprojPx": float(np.mean(errors)) if errors else 0.0,
            "meanTrackLength": float(np.mean([p[3] for p in pts])) if pts else 0.0,
            "models": len(models),
        },
    }


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    with open(path, "w") as f:
        f.write("ply\nformat ascii 1.0\ncomment Roofline scan refinement: COLMAP sparse points in ARKit world metres\n")
        f.write(f"element vertex {len(xyz)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
        for p, c in zip(xyz, rgb):
            f.write(f"{p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {int(c[0])} {int(c[1])} {int(c[2])}\n")


def refine(job: dict) -> dict:
    images = job["images"]
    opts = job.get("options", {})
    work = Path(job.get("workDir") or "work")
    if len(images) < 3:
        return {"ok": False, "reason": "too_few_images", "detail": "COLMAP needs at least three photos."}
    result = run_colmap(images, work, opts)
    if not result["ok"]:
        return result
    arkit = {im["frameId"]: column_major_to_matrix(im["cameraTransform"]) for im in images}
    colmap_poses = {i: p["c2w"] for i, p in result["poses"].items()}
    registered = sorted(colmap_poses)
    out = {
        "ok": True,
        "registered": registered,
        "unregistered": [im["frameId"] for im in images if im["frameId"] not in colmap_poses],
        "model": result["model"],
        "timings": result["timings"],
    }
    if len(registered) < 3:
        out.update({"aligned": False, "reason": "too_few_registered", "detail": f"COLMAP registered {len(registered)} of {len(images)} photos."})
        return out
    t0 = time.time()
    al = align_to_arkit(colmap_poses, arkit)
    s, r, t = al["scale"], al["rotation"], al["translation"]
    centre_cm = {i: v * 100.0 for i, v in al["centreResidualM"].items()}
    rms_cm = float(math.sqrt(np.mean([v**2 for v in centre_cm.values()])))
    rot_rms = float(math.sqrt(np.mean([v**2 for v in al["rotationResidualDeg"].values()])))
    out["alignment"] = {
        "method": al["method"],
        "spread": al["spread"],
        "scale": s,
        "rmsCm": rms_cm,
        "maxCm": max(centre_cm.values()),
        "rotationRmsDeg": rot_rms,
        "rotationMaxDeg": max(al["rotationResidualDeg"].values()),
        "perFrameCm": centre_cm,
        "perFrameDeg": al["rotationResidualDeg"],
        "registered": len(registered),
        "total": len(images),
    }
    out["aligned"] = True
    out["poses"] = {i: {"cameraTransform": matrix_to_column_major(transform_pose(colmap_poses[i], s, r, t)), "numPoints": result["poses"][i]["numPoints"]} for i in registered}
    pts = result["points"]
    keep = [p for p in pts if p[3] >= 2 and p[2] <= float(opts.get("pointMaxReprojPx", 2.0))]
    limit = int(opts.get("maxPoints", 20000))
    if len(keep) > limit:
        keep = [keep[i] for i in np.linspace(0, len(keep) - 1, limit).astype(int)]
    if keep and job.get("plyPath"):
        xyz = np.array([s * r @ p[0] + t for p in keep])
        write_ply(Path(job["plyPath"]), xyz, np.array([p[1] for p in keep]))
        out["points"] = {"count": len(keep), "ply": str(job["plyPath"])}
    else:
        out["points"] = {"count": len(keep), "ply": None}
    out["timings"]["align"] = time.time() - t0
    return out


# ---------------------------------------------------------------------------------------------------------------------


def selftest() -> None:
    """The conventions and the similarity, with no COLMAP: a few random cameras through the whole round trip."""
    rng = np.random.default_rng(3)

    def random_rotation():
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        w, x, y, z = q
        return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])

    # 1. ARKit <-> COLMAP pose conversion is a round trip, and a point in front of the camera is in front of both
    for _ in range(20):
        m = np.eye(4)
        m[:3, :3], m[:3, 3] = random_rotation(), rng.normal(size=3)
        r_cw, t_cw = arkit_to_cam_from_world(matrix_to_column_major(m))
        assert abs(np.linalg.det(r_cw) - 1) < 1e-9
        back = cam_from_world_to_arkit(r_cw, t_cw)
        assert np.allclose(back, m, atol=1e-9), "pose round trip"
        # a world point straight ahead of the ARKit camera (along -z of the camera) has +z in COLMAP's camera
        ahead = m[:3, 3] + m[:3, :3] @ np.array([0.0, 0.0, -2.0])
        assert (r_cw @ ahead + t_cw)[2] > 1.99
        # ... and a point to the camera's right (+x) is +x in COLMAP's camera, a point above (+y of ARKit) is -y (COLMAP's y is down)
        right = m[:3, 3] + m[:3, :3] @ np.array([1.0, 0.0, -2.0])
        up = m[:3, 3] + m[:3, :3] @ np.array([0.0, 1.0, -2.0])
        assert (r_cw @ right + t_cw)[0] > 0.99 and (r_cw @ up + t_cw)[1] < -0.99
    # 2. the projection of a world point agrees between the contract's formula and COLMAP's pinhole
    k = {"fx": 1500.0, "fy": 1480.0, "cx": 950.0, "cy": 730.0}
    m = np.eye(4)
    m[:3, :3], m[:3, 3] = random_rotation(), [0.3, 1.2, 2.0]
    p = m[:3, 3] + m[:3, :3] @ np.array([0.2, -0.1, -2.5])
    inv = np.linalg.inv(m)
    c = inv[:3, :3] @ p + inv[:3, 3]
    contract = (k["cx"] + k["fx"] * c[0] / -c[2], k["cy"] - k["fy"] * c[1] / -c[2])
    r_cw, t_cw = arkit_to_cam_from_world(matrix_to_column_major(m))
    cc = r_cw @ p + t_cw
    colmap = (k["fx"] * cc[0] / cc[2] + k["cx"], k["fy"] * cc[1] / cc[2] + k["cy"])
    assert np.allclose(contract, colmap, atol=1e-6), (contract, colmap)
    # 3. Umeyama recovers a known similarity (with noise) and the poses carried through it match
    s0, r0, t0 = 0.37, random_rotation(), np.array([4.0, -1.0, 2.5])
    arkit_poses, colmap_poses = {}, {}
    for i in range(7):
        m = np.eye(4)
        m[:3, :3], m[:3, 3] = random_rotation(), rng.normal(size=3) * 2
        arkit_poses[f"f{i}"] = m
        # the COLMAP-side pose is the inverse similarity of the ARKit one: x -> (R0^T (x - t0)) / s0
        inv_r = r0.T
        c2 = np.eye(4)
        c2[:3, :3] = inv_r @ m[:3, :3]
        c2[:3, 3] = inv_r @ (m[:3, 3] - t0) / s0
        colmap_poses[f"f{i}"] = c2
    al = align_to_arkit(colmap_poses, arkit_poses)
    assert al["method"] == "centres" and abs(al["scale"] - s0) < 1e-9 and np.allclose(al["rotation"], r0, atol=1e-9) and np.allclose(al["translation"], t0, atol=1e-9), al
    assert max(al["centreResidualM"].values()) < 1e-9 and max(al["rotationResidualDeg"].values()) < 1e-3
    for i in arkit_poses:
        assert np.allclose(transform_pose(colmap_poses[i], al["scale"], al["rotation"], al["translation"]), arkit_poses[i], atol=1e-9)
    # 4. centres on a line (walking along a wall): the rotation about that line comes from the orientations
    line_arkit, line_colmap = {}, {}
    for i in range(5):
        m = np.eye(4)
        small = random_rotation() * 0 + np.eye(3)
        m[:3, :3] = small
        m[:3, 3] = [i * 0.5, 1.4, 2.5]
        line_arkit[f"l{i}"] = m
        c2 = np.eye(4)
        c2[:3, :3] = r0.T @ m[:3, :3]
        c2[:3, 3] = r0.T @ (m[:3, 3] - t0) / s0
        line_colmap[f"l{i}"] = c2
    al = align_to_arkit(line_colmap, line_arkit)
    assert al["method"] == "orientations" and abs(al["scale"] - s0) < 1e-9 and np.allclose(al["rotation"], r0, atol=1e-9), al
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    ap.add_argument("--output")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        sys.exit(0)
    if not a.input or not a.output:
        ap.error("--input and --output are required")
    job = json.loads(Path(a.input).read_text())
    try:
        res = refine(job)
    except Exception as e:  # the job reads this and keeps the ARKit poses
        res = {"ok": False, "reason": "error", "detail": f"{type(e).__name__}: {e}"}
    Path(a.output).write_text(json.dumps(res))
    print(json.dumps({k: v for k, v in res.items() if k in ("ok", "reason", "aligned", "registered", "alignment", "timings", "model")}))

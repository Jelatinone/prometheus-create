"""Synthetic 3DGS PLY for editor tests and local dev (Track B, CP-011).

Splats cover the surface of the axis-box fixture (0.4 x 0.9 x 0.2 m, centred
on the origin), in the same object-local space as its mesh (S1), so the two
layers should coincide. Colour varies with height. Deterministic.

    python tests/editor/fixtures/make_box_splat.py
"""
import math
import os
import random
import struct

random.seed(7)
HALF = (0.2, 0.45, 0.1)
N = 3000
SIGMA = 0.012
C0 = 0.28209479177387814  # SH band-0 constant


def surface_point():
    w, h, d = (2 * a for a in HALF)
    areas = [h * d, h * d, w * d, w * d, w * h, w * h]
    face = random.choices(range(6), weights=areas)[0]
    axis, sign = face // 2, (-1, 1)[face % 2]
    p = [random.uniform(-a, a) for a in HALF]
    p[axis] = sign * HALF[axis]
    return p


props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % N + "".join("property float %s\n" % p for p in props) + "end_header\n"
body = bytearray()
for _ in range(N):
    x, y, z = surface_point()
    t = (y + HALF[1]) / (2 * HALF[1])
    rgb = (1.0, 0.41 + 0.3 * t, 0.26 + 0.2 * (1 - t))  # vermilion to warm amber
    dc = [(c - 0.5) / C0 for c in rgb]
    opacity = math.log(0.9 / 0.1)
    s = math.log(SIGMA)
    body += struct.pack("<14f", x, y, z, *dc, opacity, s, s, s, 1.0, 0.0, 0.0, 0.0)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "box-splat.ply")
with open(out, "wb") as f:
    f.write(header.encode("ascii") + bytes(body))
print(out, os.path.getsize(out), "bytes")

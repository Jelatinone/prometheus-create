"""Upright, hashed still frames for CT-002.

Every stored frame is orientation-normalized: its pixels are upright at the
recorded width/height, so masks drawn later align 1:1 with frame pixels.
Asset IDs use the same derivation as lib/capture/assets.ts (projectAssetId)
so the TypeScript gateway stores the frame under the ID the envelope names.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, ImageOps

SUPPORTED = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
EXIF_ORIENTATION = 0x0112
#: Clockwise rotation needed to display a frame upright -> PIL transpose.
_ROTATE_CW = {
    0: None,
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}


@dataclass(frozen=True)
class EncodedFrame:
    data: bytes
    mime_type: str
    width: int
    height: int
    content_hash: str

    @property
    def byte_size(self) -> int:
        return len(self.data)


def sha256_hash(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def project_asset_id(project_id: str, kind: str, content_hash: str) -> str:
    """Mirror of projectAssetId in lib/capture/assets.ts."""
    digest = sha256_hash(f"{project_id}:{kind}:{content_hash}")
    return "ast_" + digest[len("sha256:") : len("sha256:") + 40]


def upright(image: Image.Image, rotation_cw: int = 0) -> Image.Image:
    """Rotate a decoded frame upright without encoding it (rotation_cw in 0/90/180/270)."""
    transpose = _ROTATE_CW.get(rotation_cw)
    return image.transpose(transpose) if transpose is not None else image


def encode_upright(image: Image.Image, rotation_cw: int = 0, *, quality: int = 90, max_edge: int | None = None) -> EncodedFrame:
    """Rotate a decoded frame upright (rotation_cw in 0/90/180/270) and encode it as JPEG."""
    if rotation_cw not in _ROTATE_CW:
        raise ValueError(f"rotation must be 0, 90, 180 or 270, got {rotation_cw}")
    upright = image.convert("RGB")
    transpose = _ROTATE_CW[rotation_cw]
    if transpose is not None:
        upright = upright.transpose(transpose)
    if max_edge and max(upright.size) > max_edge:
        upright.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    upright.save(buf, format="JPEG", quality=quality)
    data = buf.getvalue()
    return EncodedFrame(data, "image/jpeg", upright.width, upright.height, sha256_hash(data))


def from_encoded(data: bytes) -> EncodedFrame:
    """Accept already-encoded bytes; re-encode only if an EXIF rotation is pending."""
    with Image.open(io.BytesIO(data)) as img:
        fmt = img.format
        if fmt not in SUPPORTED:
            raise ValueError(f"unsupported frame format {fmt!r}; expected JPEG, PNG or WebP")
        orientation = img.getexif().get(EXIF_ORIENTATION, 1)
        if orientation == 1:
            return EncodedFrame(data, SUPPORTED[fmt], img.width, img.height, sha256_hash(data))
        return encode_upright(ImageOps.exif_transpose(img))


def signature(image: Image.Image, size: int = 16) -> bytes:
    """Tiny grayscale thumbnail used to notice a changed camera view."""
    return image.convert("L").resize((size, size), Image.Resampling.BILINEAR).tobytes()


def difference(a: bytes, b: bytes) -> float:
    """Mean absolute difference of two signatures, 0 (same) to 255."""
    if len(a) != len(b) or not a:
        return 255.0
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

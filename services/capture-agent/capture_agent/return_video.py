"""Return video for the caller (HK-011 CP-023).

The agent publishes one portrait video track showing what Prometheus
recognises: the keyframe the live loop last segmented, each object boxed and
coloured from red (little coverage) to green (well covered), and a one-line
status. Before anything is recognised it shows the newest captured frame.

- The overlay comes from the live loop (lib/capture/live-loop-cli.mts) as
  <outbox>/overlay.json; boxes are normalized to the full captured frame.
- Caller capture includes FaceTime UI: black side bars, and a small tile
  where FaceTime shows *our* video. That tile is blanked before rendering so
  our picture never contains itself (no echo loop).
- One slot, newest state only: the publisher re-sends the latest render at a
  fixed rate and never queues frames.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

SIZE = (720, 1280)
STATUS_HEIGHT = 160
FPS = 10
#: Video encoder limits for the caller-facing track (default bitrates looked soft on a call).
MAX_BITRATE = 3_000_000
#: Trim FaceTime UI from the phone picture (left, top, right, bottom fractions):
#: the icon and name pills at the top, the call controls at the bottom and the
#: rounded corners (CP-023 call feedback).
PICTURE_INSET = (0.03, 0.085, 0.03, 0.11)
#: Where FaceTime draws the far-end (our) video inside the caller capture, as a
#: fraction of the cropped phone picture. With our portrait track it is a
#: portrait tile: measured on the CP-023 call (1280x720 capture, picture
#: x 400-880, tile x 424-514 / y 503-698), padded. (Without our video it was a
#: dark landscape tile, x 425-592 / y 587-697, which is dark anyway.)
ECHO_TILE = (0.03, 0.68, 0.26, 0.985)
INK = (23, 25, 29)
PAPER = (243, 240, 233)
RED = (229, 72, 77)
GREEN = (48, 164, 108)
AMBER = (240, 160, 40)
MAX_SAVED = 60


def coverage_color(score: float) -> tuple[int, int, int]:
    """Red at 0, amber at 0.5, green at 1 (a straight red-green blend is muddy in the middle)."""
    t = min(1.0, max(0.0, score))
    a, b, u = (RED, AMBER, t * 2) if t < 0.5 else (AMBER, GREEN, t * 2 - 1)
    return tuple(round(x + (y - x) * u) for x, y in zip(a, b))  # type: ignore[return-value]


def content_box(frame: Image.Image, threshold: int = 12) -> tuple[int, int, int, int]:
    """Bounding box of the non-black picture (drops letterbox bars); the whole frame if none."""
    gray = frame.convert("L").point(lambda v: 255 if v > threshold else 0)
    return gray.getbbox() or (0, 0, frame.width, frame.height)


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def picture_box(frame: Image.Image) -> tuple[float, float, float, float]:
    """The phone picture without letterbox bars or FaceTime UI, in frame pixels."""
    left, top, right, bottom = content_box(frame)
    w, h = right - left, bottom - top
    il, it, ir, ib = PICTURE_INSET
    return left + il * w, top + it * h, right - ir * w, bottom - ib * h


def render(frame: Image.Image | None, overlay: dict[str, Any] | None, size: tuple[int, int] = SIZE) -> Image.Image:
    """The picture the caller sees: frame (cropped, echo tile blanked), coloured boxes, status line."""
    width, height = size
    k = width / 540  # type sizes were tuned at 540 px wide
    out = Image.new("RGB", size, INK)
    draw = ImageDraw.Draw(out)
    area_h = height - STATUS_HEIGHT
    objects = (overlay or {}).get("objects") or []
    if frame is not None:
        frame = frame.convert("RGB")
        cl, ct, cr, cb = content_box(frame)
        cw, ch = cr - cl, cb - ct
        blanked = frame.copy()
        # The echo tile is measured on the whole phone picture, so blank it before trimming the UI.
        ImageDraw.Draw(blanked).rectangle((cl + ECHO_TILE[0] * cw, ct + ECHO_TILE[1] * ch, cl + ECHO_TILE[2] * cw, ct + ECHO_TILE[3] * ch), fill=INK)
        left, top, right, bottom = (round(v) for v in picture_box(frame))
        picture = blanked.crop((left, top, right, bottom))
        pw, ph = picture.size
        scale = min(width / pw, area_h / ph)
        sw, sh = max(1, round(pw * scale)), max(1, round(ph * scale))
        ox, oy = (width - sw) // 2, (area_h - sh) // 2
        out.paste(picture.resize((sw, sh), Image.Resampling.LANCZOS), (ox, oy))
        fw, fh = frame.size
        label_font = _font(round(26 * k))
        for obj in objects:
            x0, y0, x1, y1 = obj["box"]
            # Normalized on the full frame -> cropped picture -> canvas.
            bx0 = ox + (x0 * fw - left) * scale
            by0 = oy + (y0 * fh - top) * scale
            bx1 = ox + (x1 * fw - left) * scale
            by1 = oy + (y1 * fh - top) * scale
            color = coverage_color(float(obj.get("score", 0)))
            # Clip to the picture: a box may extend into the trimmed UI.
            bx0, bx1 = max(ox, bx0), min(ox + sw, bx1)
            by0, by1 = max(oy, by0), min(oy + sh, by1)
            if bx1 <= bx0 or by1 <= by0:
                continue
            draw.rectangle((bx0, by0, bx1, by1), outline=color, width=round(6 * k))
            label = f"{round(float(obj.get('score', 0)) * 100)}%"
            lw = draw.textlength(label, font=label_font)
            ly = max(0, by0 - 36 * k)
            draw.rectangle((bx0, ly, bx0 + lw + 16 * k, ly + 34 * k), fill=color)
            draw.text((bx0 + 8 * k, ly + 3 * k), label, fill=PAPER, font=label_font)
    else:
        draw.text((width / 2, area_h / 2), "Waiting for your camera", fill=PAPER, font=_font(round(30 * k)), anchor="mm")
    draw.rectangle((0, area_h, width, height), fill=PAPER)
    status = (overlay or {}).get("status") or "Prometheus is watching"
    # Wordmark: charcoal with only the "::" in the accent colour.
    brand_font = _font(round(24 * k))
    brand_x = 24 * k
    for part, fill in (("Prometheus", INK), ("::", (255, 104, 66)), ("create", INK)):
        draw.text((brand_x, area_h + 22 * k), part, fill=fill, font=brand_font)
        brand_x += draw.textlength(part, font=brand_font)
    status_font = _font(round(30 * k))
    draw.text((24 * k, area_h + 56 * k), _fit(draw, status, status_font, width - 48 * k), fill=INK, font=status_font)
    return out


def _fit(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
    if draw.textlength(text, font=font) <= max_width:
        return text
    while text and draw.textlength(text + "…", font=font) > max_width:
        text = text[:-1]
    return text + "…"


class ReturnVideoState:
    """Inputs for the next render: the outbox and the newest captured frame number."""

    def __init__(self, outbox: Path):
        self.outbox = Path(outbox)
        self.latest_sequence: int | None = None
        #: Every incoming caller frame (upright), so the picture is live before anything is recognised.
        self.live: Image.Image | None = None
        self.live_count = 0
        self.published = 0
        self.renders = 0
        self.saved = 0
        self._overlay_mtime: float | None = None
        self._overlay: dict[str, Any] | None = None
        self._frames: dict[int, Image.Image] = {}

    def overlay(self) -> dict[str, Any] | None:
        path = self.outbox / "overlay.json"
        try:
            mtime = path.stat().st_mtime
            if mtime != self._overlay_mtime:
                self._overlay = json.loads(path.read_text(encoding="utf-8"))
                self._overlay_mtime = mtime
        except (OSError, ValueError):
            pass
        return self._overlay

    def frame(self, sequence: int | None) -> Image.Image | None:
        if sequence is None:
            return None
        if sequence not in self._frames:
            path = self.outbox / "frames" / f"{sequence:06d}.jpg"
            try:
                with Image.open(path) as img:
                    img.thumbnail((1280, 1280))
                    self._frames[sequence] = img.convert("RGB")
                while len(self._frames) > 4:  # small cache: the keyframe and a few recent frames
                    self._frames.pop(next(iter(self._frames)))
            except OSError:
                return None
        return self._frames.get(sequence)

    def show_live(self, image: Image.Image) -> None:
        self.live = image
        self.live_count += 1

    def inputs(self) -> tuple[Image.Image | None, dict[str, Any] | None, tuple]:
        """The keyframe with its boxes once something is recognised; until then the live picture."""
        overlay = self.overlay()
        keyframe = (overlay or {}).get("keyframe")
        updated = (overlay or {}).get("updatedAtMs")
        if keyframe:
            return self.frame(keyframe["sequence"]), overlay, ("key", keyframe["sequence"], updated)
        if self.live is not None:
            return self.live, overlay, ("live", self.live_count, updated)
        return self.frame(self.latest_sequence), overlay, ("seq", self.latest_sequence, updated)


async def publish_return_video(room, state: ReturnVideoState, fps: int = FPS) -> asyncio.Task:
    """Publish the caller-facing track; re-render only when inputs change, re-send at a fixed rate."""
    from livekit import rtc

    width, height = SIZE
    source = rtc.VideoSource(width, height)
    track = rtc.LocalVideoTrack.create_video_track("agent-video", source)
    options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA, simulcast=False)
    options.video_encoding.max_bitrate = MAX_BITRATE
    options.video_encoding.max_framerate = fps
    await room.local_participant.publish_track(track, options)
    saved_dir = state.outbox / "return-video"
    saved_dir.mkdir(exist_ok=True)

    async def pump():
        last_key: tuple | None = None
        last_saved_kind: tuple | None = None
        rgba: bytes = render(None, None).convert("RGBA").tobytes()
        while True:
            frame, overlay, key = state.inputs()
            if key != last_key:
                picture = render(frame, overlay)
                rgba = picture.convert("RGBA").tobytes()
                state.renders += 1
                last_key = key
                # Evidence of what the caller was shown: every overlay change, and every 20th live render.
                kind = (key[0], key[-1])
                if state.saved < MAX_SAVED and (kind != last_saved_kind or state.renders % 20 == 0):
                    picture.save(saved_dir / f"{state.saved:03d}.jpg", quality=80)
                    state.saved += 1
                    last_saved_kind = kind
            source.capture_frame(rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, rgba))
            state.published += 1
            await asyncio.sleep(1 / fps)

    return asyncio.create_task(pump())

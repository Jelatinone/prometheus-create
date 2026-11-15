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

SIZE = (540, 960)
STATUS_HEIGHT = 120
FPS = 4
#: Where FaceTime draws the far-end (our) video inside the caller capture, as a
#: fraction of the cropped phone picture. Measured on the CP-022 call
#: (1280x720 capture, picture x 400-880, tile x 425-592 / y 587-697), padded.
ECHO_TILE = (0.03, 0.8, 0.42, 0.985)
INK = (23, 25, 29)
PAPER = (243, 240, 233)
RED = (229, 72, 77)
GREEN = (48, 164, 108)
AMBER = (240, 160, 40)
MAX_SAVED = 40


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


def render(frame: Image.Image | None, overlay: dict[str, Any] | None, size: tuple[int, int] = SIZE) -> Image.Image:
    """The picture the caller sees: frame (cropped, echo tile blanked), coloured boxes, status line."""
    width, height = size
    out = Image.new("RGB", size, INK)
    draw = ImageDraw.Draw(out)
    area_h = height - STATUS_HEIGHT
    objects = (overlay or {}).get("objects") or []
    if frame is not None:
        frame = frame.convert("RGB")
        left, top, right, bottom = content_box(frame)
        picture = frame.crop((left, top, right, bottom))
        pw, ph = picture.size
        tile = ImageDraw.Draw(picture)
        tile.rectangle((ECHO_TILE[0] * pw, ECHO_TILE[1] * ph, ECHO_TILE[2] * pw, ECHO_TILE[3] * ph), fill=INK)
        scale = min(width / pw, area_h / ph)
        sw, sh = max(1, round(pw * scale)), max(1, round(ph * scale))
        ox, oy = (width - sw) // 2, (area_h - sh) // 2
        out.paste(picture.resize((sw, sh), Image.Resampling.BILINEAR), (ox, oy))
        fw, fh = frame.size
        label_font = _font(26)
        for obj in objects:
            x0, y0, x1, y1 = obj["box"]
            # Normalized on the full frame -> cropped picture -> canvas.
            bx0 = ox + (x0 * fw - left) * scale
            by0 = oy + (y0 * fh - top) * scale
            bx1 = ox + (x1 * fw - left) * scale
            by1 = oy + (y1 * fh - top) * scale
            color = coverage_color(float(obj.get("score", 0)))
            draw.rectangle((bx0, by0, bx1, by1), outline=color, width=6)
            label = f"{round(float(obj.get('score', 0)) * 100)}%"
            lw = draw.textlength(label, font=label_font)
            ly = max(0, by0 - 36)
            draw.rectangle((bx0, ly, bx0 + lw + 16, ly + 34), fill=color)
            draw.text((bx0 + 8, ly + 3), label, fill=PAPER, font=label_font)
    else:
        draw.text((width / 2, area_h / 2), "Waiting for your camera", fill=PAPER, font=_font(30), anchor="mm")
    draw.rectangle((0, area_h, width, height), fill=PAPER)
    status = (overlay or {}).get("status") or "Prometheus is watching"
    draw.text((24, area_h + 22), "Prometheus::create", fill=(255, 104, 66), font=_font(24))
    draw.text((24, area_h + 56), _fit(draw, status, _font(30), width - 48), fill=INK, font=_font(30))
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

    def inputs(self) -> tuple[Image.Image | None, dict[str, Any] | None, tuple]:
        overlay = self.overlay()
        keyframe = (overlay or {}).get("keyframe")
        sequence = keyframe["sequence"] if keyframe else self.latest_sequence
        key = (sequence, (overlay or {}).get("updatedAtMs"))
        return self.frame(sequence), overlay, key


async def publish_return_video(room, state: ReturnVideoState, fps: int = FPS) -> asyncio.Task:
    """Publish the caller-facing track; re-render only when inputs change, re-send at a fixed rate."""
    from livekit import rtc

    width, height = SIZE
    source = rtc.VideoSource(width, height)
    track = rtc.LocalVideoTrack.create_video_track("agent-video", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA))
    saved_dir = state.outbox / "return-video"
    saved_dir.mkdir(exist_ok=True)

    async def pump():
        last_key: tuple | None = None
        rgba: bytes = render(None, None).convert("RGBA").tobytes()
        while True:
            frame, overlay, key = state.inputs()
            if key != last_key:
                picture = render(frame, overlay)
                rgba = picture.convert("RGBA").tobytes()
                state.renders += 1
                last_key = key
                if state.saved < MAX_SAVED:  # evidence: what the caller was shown
                    picture.save(saved_dir / f"{state.saved:03d}.jpg", quality=80)
                    state.saved += 1
            source.capture_frame(rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, rgba))
            state.published += 1
            await asyncio.sleep(1 / fps)

    return asyncio.create_task(pump())

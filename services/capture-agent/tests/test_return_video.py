"""HK-011 CP-023: the caller-facing render (no LiveKit needed)."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from capture_agent.return_video import AMBER, ECHO_TILE, GREEN, INK, PAPER, RED, SIZE, STATUS_HEIGHT, ReturnVideoState, content_box, coverage_color, picture_box, render


def letterboxed(color=(120, 140, 160)) -> Image.Image:
    """A 1280x720 caller capture: a 480-wide phone picture between black bars."""
    frame = Image.new("RGB", (1280, 720), (0, 0, 0))
    frame.paste(Image.new("RGB", (480, 720), color), (400, 0))
    return frame


def test_coverage_colour_runs_from_red_to_green():
    assert coverage_color(0) == RED
    assert coverage_color(1) == GREEN
    assert coverage_color(-3) == RED and coverage_color(7) == GREEN
    assert coverage_color(0.5) == AMBER
    quarter = coverage_color(0.25)
    assert all(min(r, a) <= q <= max(r, a) for r, a, q in zip(RED, AMBER, quarter))


def test_content_box_drops_letterbox_bars():
    assert content_box(letterboxed()) == (400, 0, 880, 720)
    assert content_box(Image.new("RGB", (64, 48))) == (0, 0, 64, 48)  # all black: keep the frame


def _canvas_point(frame, x: float, y: float) -> tuple[int, int]:
    """Where frame pixel (x, y) lands on the render (same maths as render())."""
    left, top, right, bottom = (round(v) for v in picture_box(frame))
    pw, ph = right - left, bottom - top
    scale = min(SIZE[0] / pw, (SIZE[1] - STATUS_HEIGHT) / ph)
    ox = (SIZE[0] - round(pw * scale)) // 2
    oy = (SIZE[1] - STATUS_HEIGHT - round(ph * scale)) // 2
    return round(ox + (x - left) * scale), round(oy + (y - top) * scale)


def test_render_draws_coloured_boxes_on_the_trimmed_picture_and_blanks_the_echo_tile():
    frame = letterboxed()
    overlay = {"status": "Found can · 80%", "objects": [{"box": [0.45, 0.2, 0.6, 0.6], "score": 1.0}]}
    out = render(frame, overlay)
    assert out.size == SIZE == (720, 1280)
    # FaceTime UI is trimmed: the picture box sits inside the phone picture on every side.
    left, top, right, bottom = picture_box(frame)
    assert 400 < left and top > 0 and right < 880 and bottom < 720
    # The box's left edge (x = 0.45 * 1280 = 576) is green.
    x, y = _canvas_point(frame, 576, 0.4 * 720)
    assert out.getpixel((x + 2, y)) == GREEN
    # The echo tile (measured on the whole phone picture) is blanked; the rest of the picture is not.
    assert out.getpixel(_canvas_point(frame, 400 + 0.15 * 480, 0.85 * 720)) == INK
    assert out.getpixel(_canvas_point(frame, 400 + 0.8 * 480, 0.85 * 720)) == (120, 140, 160)
    # The status bar is paper-coloured with text on it.
    bar = out.crop((0, SIZE[1] - STATUS_HEIGHT, SIZE[0], SIZE[1]))
    assert PAPER in [c for _, c in bar.getcolors(1 << 16)]
    assert len(bar.getcolors(1 << 16)) > 2


def test_live_frames_show_until_something_is_recognised(tmp_path: Path):
    state = ReturnVideoState(tmp_path)
    state.show_live(Image.new("RGB", (40, 20), (200, 0, 0)))
    frame, overlay, key = state.inputs()
    assert frame.getpixel((1, 1)) == (200, 0, 0) and key[:2] == ("live", 1)
    state.show_live(Image.new("RGB", (40, 20), (0, 200, 0)))
    assert state.inputs()[2][:2] == ("live", 2)  # every new caller frame is a new render


def test_render_without_a_frame_or_overlay():
    out = render(None, None)
    assert out.size == SIZE and out.getpixel((5, 5)) == INK


def test_echo_tile_is_inside_the_picture():
    x0, y0, x1, y1 = ECHO_TILE
    assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1


def test_state_uses_the_keyframe_when_there_is_one_else_the_newest_frame(tmp_path: Path):
    (tmp_path / "frames").mkdir()
    for seq, shade in ((3, 30), (9, 200)):
        Image.new("RGB", (40, 20), (shade, shade, shade)).save(tmp_path / "frames" / f"{seq:06d}.jpg")
    state = ReturnVideoState(tmp_path)
    state.latest_sequence = 9
    frame, overlay, key = state.inputs()
    assert overlay is None and frame.getpixel((5, 5))[0] > 150 and key[:2] == ("seq", 9)
    (tmp_path / "overlay.json").write_text(json.dumps({"keyframe": {"observationId": "obs_x", "sequence": 3}, "objects": [], "updatedAtMs": 1}))
    frame, overlay, key = state.inputs()
    assert overlay["keyframe"]["sequence"] == 3 and frame.getpixel((5, 5))[0] < 60 and key == ("key", 3, 1)
    state.latest_sequence = 12  # missing file: no crash, no frame
    (tmp_path / "overlay.json").unlink()
    assert state.inputs()[0] is not None  # the cached overlay is kept until a new one is written

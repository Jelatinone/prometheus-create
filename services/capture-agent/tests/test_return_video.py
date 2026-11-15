"""HK-011 CP-023: the caller-facing render (no LiveKit needed)."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from capture_agent.return_video import AMBER, ECHO_TILE, GREEN, INK, PAPER, RED, SIZE, STATUS_HEIGHT, ReturnVideoState, content_box, coverage_color, render


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


def test_render_draws_coloured_boxes_on_the_cropped_picture_and_blanks_the_echo_tile():
    overlay = {"status": "Found can: 80% covered", "objects": [{"box": [0.45, 0.2, 0.6, 0.6], "score": 1.0}]}
    out = render(letterboxed(), overlay)
    assert out.size == SIZE
    # Picture 480x720 scaled into 540x840: scale 7/6, height 840 -> width 560 > 540, so scale = 540/480 = 1.125.
    scale = 540 / 480
    oy = (SIZE[1] - STATUS_HEIGHT - round(720 * scale)) // 2
    # The box's left edge (x = 0.45 * 1280 = 576 -> 176 px into the picture) is green.
    x = round((576 - 400) * scale) + 2
    y = oy + round(0.4 * 720 * scale)
    assert out.getpixel((x, y)) == GREEN
    # The echo tile (bottom-left of the picture) is blanked, the rest of the picture is not.
    tx, ty = round(0.1 * 480 * scale), oy + round(0.9 * 720 * scale)
    assert out.getpixel((tx, ty)) == INK
    assert out.getpixel((round(0.8 * 480 * scale), ty)) == (120, 140, 160)
    # The status bar is paper-coloured with text on it.
    bar = out.crop((0, SIZE[1] - STATUS_HEIGHT, SIZE[0], SIZE[1]))
    assert PAPER in [c for _, c in bar.getcolors(1 << 16)]
    assert len(bar.getcolors(1 << 16)) > 2


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
    assert overlay is None and frame.getpixel((5, 5))[0] > 150 and key[0] == 9
    (tmp_path / "overlay.json").write_text(json.dumps({"keyframe": {"observationId": "obs_x", "sequence": 3}, "objects": [], "updatedAtMs": 1}))
    frame, overlay, key = state.inputs()
    assert overlay["keyframe"]["sequence"] == 3 and frame.getpixel((5, 5))[0] < 60 and key == (3, 1)
    state.latest_sequence = 12  # missing file: no crash, no frame
    (tmp_path / "overlay.json").unlink()
    assert state.inputs()[0] is not None  # the cached overlay is kept until a new one is written

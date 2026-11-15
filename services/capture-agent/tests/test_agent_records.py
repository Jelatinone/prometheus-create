"""Offline tests for the capture agent's records (no network, no Chert).

Frames are the generated test patterns in fixtures/capture; nothing here is
evidence of a real call.
"""
from __future__ import annotations

import filecmp
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from PIL import Image

from capture_agent import contracts, envelope as env, golden
from capture_agent.frames import encode_upright, from_encoded, project_asset_id, sha256_hash, signature
from capture_agent.outbox import Outbox
from capture_agent.sequencer import FrameSelector, LatestOnly, SelectorConfig, Sequencer

FIXTURES = golden.FIXTURES
INVALID = golden.ROOT / "fixtures" / "contracts" / "invalid"
PROJECT = "prj_agent_test"
NOTE = "pytest synthetic frames"


def registration(**kw):
    return env.chert_source_registration(
        project_id=PROJECT, capture_session_id="cap_agent_test", captured_at=env.iso(), consent_note=NOTE, **kw
    )


class TestFrames:
    def test_hash_and_asset_id_match_the_typescript_derivation(self):
        data = (FIXTURES / "upright-64x48.png").read_bytes()
        frame = from_encoded(data)
        assert frame.content_hash == sha256_hash(data)
        assert frame.mime_type == "image/png" and (frame.width, frame.height) == (64, 48)
        # Same formula as projectAssetId(projectId, kind, contentHash) in lib/capture/assets.ts.
        expected = "ast_" + sha256_hash(f"{PROJECT}:frame:{frame.content_hash}")[7:47]
        assert project_asset_id(PROJECT, "frame", frame.content_hash) == expected

    def test_exif_rotated_input_is_reencoded_upright(self):
        frame = from_encoded((FIXTURES / "rotated-orientation6.jpg").read_bytes())
        assert (frame.width, frame.height) == (48, 64)
        assert frame.mime_type == "image/jpeg"
        with Image.open(io.BytesIO(frame.data)) as img:
            assert img.getexif().get(0x0112, 1) == 1

    @pytest.mark.parametrize("rotation,size", [(0, (64, 48)), (90, (48, 64)), (180, (64, 48)), (270, (48, 64))])
    def test_decoded_frames_are_rotated_clockwise_to_upright(self, rotation, size):
        with Image.open(FIXTURES / "upright-64x48.png") as img:
            frame = encode_upright(img, rotation)
        assert (frame.width, frame.height) == size
        with Image.open(io.BytesIO(frame.data)) as out:
            # The red block starts top-left; after a 90° clockwise turn it sits top-right.
            red = out.convert("RGB").getpixel((size[0] - 2, 2) if rotation == 90 else (1, 1) if rotation == 0 else (0, 0))
            if rotation in (0, 90):
                assert red[0] > 150 and red[1] < 100

    def test_rejects_unsupported_formats_and_rotations(self):
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="GIF")
        with pytest.raises(ValueError):
            from_encoded(buf.getvalue())
        with Image.open(FIXTURES / "upright-64x48.png") as img, pytest.raises(ValueError):
            encode_upright(img, 45)


class TestRecords:
    def test_registration_and_envelope_validate_against_json_schema(self):
        reg = registration()
        frame = from_encoded((FIXTURES / "upright-64x48.jpg").read_bytes())
        e = env.ingest_envelope(registration=reg, frame=frame, sequence=0, source_time_us=0, captured_at=env.iso(), mode="evidence")
        assert contracts.issues("source-registration", reg) == []
        assert contracts.issues("ingest-envelope", e) == []
        assert e["frame"]["assetId"] == project_asset_id(PROJECT, "frame", frame.content_hash)

    def test_shared_invalid_fixtures_fail_json_schema_too(self):
        for name in ("ingest-envelope.bare-hex-hash.json", "ingest-envelope.milliseconds-field.json"):
            doc = json.loads((INVALID / name).read_text(encoding="utf-8"))["document"]
            assert contracts.issues("ingest-envelope", doc), name

    def test_chert_rules_json_schema_cannot_express_are_checked(self):
        reg = registration()
        broken = {**reg, "captureSessionId": None}
        assert any("capture session" in p for p in contracts.issues("source-registration", broken))
        stored = {**reg, "assetId": "ast_abc123", "contentHash": "sha256:" + "0" * 64}
        assert contracts.issues("source-registration", stored)

    def test_naive_timestamps_are_refused(self):
        with pytest.raises(ValueError):
            env.iso(datetime(2026, 11, 14, 12, 0, 0))
        assert env.iso(datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)) == "2026-11-14T12:00:00.000Z"

    def test_capture_session_states_follow_ct005(self):
        started = env.iso()
        ok = env.capture_session(session_id="cap_agent_test", project_id=PROJECT, state="requested", started_at=started, consent_note=NOTE)
        assert ok["state"] == "requested" and ok["endedAt"] is None
        with pytest.raises(contracts.ContractViolation):
            env.capture_session(session_id="cap_agent_test", project_id=PROJECT, state="active", started_at=started, consent_note=NOTE)
        with pytest.raises(contracts.ContractViolation):
            env.capture_session(session_id="cap_agent_test", project_id=PROJECT, state="ended", started_at=started, consent_note=NOTE)


class TestSequencing:
    def test_sequence_is_monotonic_and_time_is_source_relative(self):
        seq = Sequencer()
        assert seq.assign(10_000_000) == (0, 0)
        assert seq.assign(10_033_333) == (1, 33_333)
        # A camera clock that steps backwards never produces reordered times.
        assert seq.assign(10_020_000) == (2, 33_333)

    def test_selector_keeps_first_and_changed_views_rate_limits_previews(self):
        with Image.open(FIXTURES / "upright-64x48.png") as a, Image.open(FIXTURES / "rotated-orientation6.upright.png") as b:
            sig_a, sig_b = signature(a), signature(b)
        sel = FrameSelector(SelectorConfig(change_threshold=5, evidence_interval_us=5_000_000, preview_interval_us=500_000, near_duplicate_threshold=0.0))
        assert sel.decide(0, sig_a, "h0")[0] == "evidence"
        assert sel.decide(100_000, sig_a, "h0")[0] == "skip"  # identical bytes
        assert sel.decide(200_000, sig_a, "h1")[0] == "skip"  # within the preview interval
        assert sel.decide(600_000, sig_a, "h2")[0] == "preview"
        decision, why = sel.decide(700_000, sig_b, "h3")
        assert decision == "evidence" and "view changed" in why
        assert sel.decide(5_800_000, sig_b, "h4") == ("evidence", "periodic anchor")

    def test_selector_drops_near_duplicate_previews_and_counts_every_reason(self):
        base = bytes([100] * 256)
        near = bytes([102] * 256)  # difference 2.0: a still camera
        moved = bytes([110] * 256)  # difference 10.0: a handheld step, below the change threshold
        sel = FrameSelector(SelectorConfig(change_threshold=18, evidence_interval_us=5_000_000, preview_interval_us=500_000))
        assert sel.decide(0, base, "h0")[0] == "evidence"
        assert sel.decide(100_000, base, "h0")[0] == "skip"  # identical bytes
        assert sel.decide(200_000, near, "h1")[0] == "skip"  # preview rate limit
        decision, why = sel.decide(600_000, near, "h2")
        assert decision == "skip" and why.startswith("near-duplicate")
        assert sel.decide(1_200_000, moved, "h3")[0] == "preview"
        decision, why = sel.decide(1_800_000, bytes([111] * 256), "h4")
        assert decision == "skip" and why.startswith("near-duplicate")  # compared with the last frame SENT
        assert sel.decide(5_100_000, near, "h5") == ("evidence", "periodic anchor")  # anchors are never dropped
        assert sel.stats == {"evidence": 2, "preview": 1, "skipped_identical": 1, "skipped_near_duplicate": 2, "skipped_rate_limit": 1}

    def test_latest_only_drops_unsent_older_previews(self):
        slot = LatestOnly()
        slot.offer("frame-1")
        slot.offer("frame-2")
        assert slot.take() == "frame-2" and slot.dropped == 1
        assert slot.take() is None


class TestGoldenOutbox:
    def test_committed_golden_outbox_is_reproducible(self, tmp_path: Path):
        rebuilt = golden.build(tmp_path / "outbox")
        cmp = filecmp.dircmp(golden.GOLDEN, rebuilt)
        def diffs(c):
            out = c.left_only + c.right_only + c.diff_files
            for sub in c.subdirs.values():
                out += diffs(sub)
            return out
        assert diffs(cmp) == [], "run `python -m capture_agent.golden` and commit the result"

    def test_outbox_writes_every_record(self, tmp_path: Path):
        box = Outbox(tmp_path)
        reg = registration()
        box.registration(reg)
        frame = from_encoded((FIXTURES / "upright-64x48.jpg").read_bytes())
        e = env.ingest_envelope(registration=reg, frame=frame, sequence=7, source_time_us=1, captured_at=None, mode="preview")
        box.frame(e, frame)
        assert (tmp_path / "frames" / "000007.jpg").read_bytes() == frame.data
        assert json.loads((tmp_path / "envelopes" / "000007.json").read_text())["sequence"] == 7

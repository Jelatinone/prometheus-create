"""Regenerate the synthetic golden outbox used by cross-language tests.

    services/capture-agent/.venv/Scripts/python -m capture_agent.golden   (Windows)
    services/capture-agent/.venv/bin/python -m capture_agent.golden       (Linux/WSL)

SYNTHETIC FIXTURE: the frames are generated test patterns from
fixtures/capture, run through the agent's real builders with fixed IDs and
times. It is not a real call and never counts as Chert evidence.
"""
from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import envelope as env
from .frames import from_encoded
from .outbox import Outbox
from .sequencer import Sequencer

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "fixtures" / "capture"
GOLDEN = FIXTURES / "agent-outbox.synthetic"

PROJECT_ID = "prj_fixture_agent_outbox"
SOURCE_ID = "src_fixture_agent_call"
SESSION_ID = "cap_fixture_agent_call"
NOTE = "SYNTHETIC FIXTURE: generated test frames through the agent builders; not a real Chert call"
START = datetime(2026, 11, 14, 20, 0, 0, tzinfo=timezone.utc)

#: (file, presentation time in µs, mode). The third frame is portrait: live call dimensions may change.
FRAMES = [
    ("upright-64x48.jpg", 0, "evidence"),
    ("upright-64x48.png", 500_000, "preview"),
    ("rotated-orientation6.upright.png", 1_000_000, "evidence"),
]


def build(target: Path = GOLDEN) -> Path:
    if target.exists():
        shutil.rmtree(target)
    box = Outbox(target)
    started = env.iso(START)
    box.registration(
        env.chert_source_registration(
            project_id=PROJECT_ID,
            capture_session_id=SESSION_ID,
            captured_at=started,
            consent_note=NOTE,
            source_id=SOURCE_ID,
        )
    )
    reg = env.chert_source_registration(
        project_id=PROJECT_ID, capture_session_id=SESSION_ID, captured_at=started, consent_note=NOTE, source_id=SOURCE_ID
    )
    seq = Sequencer()
    for name, t_us, mode in FRAMES:
        frame = from_encoded((FIXTURES / name).read_bytes())
        sequence, source_time = seq.assign(t_us)
        captured = env.iso(START + timedelta(microseconds=t_us))
        box.frame(
            env.ingest_envelope(
                registration=reg, frame=frame, sequence=sequence, source_time_us=source_time, captured_at=captured, mode=mode
            ),
            frame,
        )
    box.session(
        env.capture_session(
            session_id=SESSION_ID,
            project_id=PROJECT_ID,
            state="ended",
            started_at=started,
            consent_note=NOTE,
            provider_call_id=None,
            caller_video="available",
            ended_at=env.iso(START + timedelta(seconds=2)),
            end_reason="synthetic fixture complete",
        )
    )
    # The log is run-specific noise for a fixture; keep the golden folder deterministic.
    (target / "log.ndjson").unlink(missing_ok=True)
    return target


if __name__ == "__main__":
    print("wrote", build())

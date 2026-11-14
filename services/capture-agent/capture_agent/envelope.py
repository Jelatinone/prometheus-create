"""Build CT-002 / CT-005 records for a Chert caller-video source.

One call = one live_stream source (adapter "chert_facetime") bound to its
capture session; each selected caller frame = one IngestEnvelope. Records are
validated against the generated JSON Schema before they are returned.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from . import contracts
from .frames import EncodedFrame, project_asset_id

PREFIXES = {"project": "prj", "source": "src", "captureSession": "cap", "asset": "ast", "observation": "obs"}
Mode = Literal["evidence", "preview"]


def new_id(kind: str) -> str:
    return f"{PREFIXES[kind]}_{uuid.uuid4().hex}"


def iso(moment: datetime | None = None) -> str:
    """RFC 3339 with an explicit offset (contracts reject naive times)."""
    moment = moment or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def consent(note: str, recorded_at: str, basis: str = "participant_opt_in") -> dict[str, Any]:
    return {"basis": basis, "recordedAt": recorded_at, "note": note}


def chert_source_registration(
    *,
    project_id: str,
    capture_session_id: str,
    captured_at: str,
    consent_note: str,
    source_id: str | None = None,
    width: int | None = None,
    height: int | None = None,
) -> dict[str, Any]:
    reg = {
        "schemaVersion": 1,
        "id": source_id or new_id("source"),
        "projectId": project_id,
        "adapter": "chert_facetime",
        "media": {"kind": "live_stream", "width": width, "height": height},
        "assetId": None,
        "contentHash": None,
        "capturedAt": captured_at,
        "captureSessionId": capture_session_id,
        "consent": consent(consent_note, captured_at),
    }
    return contracts.require_valid("source-registration", reg)


def frame_ref(project_id: str, frame: EncodedFrame) -> dict[str, Any]:
    return {
        "assetId": project_asset_id(project_id, "frame", frame.content_hash),
        "mimeType": frame.mime_type,
        "byteSize": frame.byte_size,
        "width": frame.width,
        "height": frame.height,
        "contentHash": frame.content_hash,
    }


def ingest_envelope(
    *,
    registration: dict[str, Any],
    frame: EncodedFrame,
    sequence: int,
    source_time_us: int,
    captured_at: str | None,
    mode: Mode,
) -> dict[str, Any]:
    env = {
        "schemaVersion": 1,
        "projectId": registration["projectId"],
        "sourceId": registration["id"],
        "adapter": registration["adapter"],
        "captureSessionId": registration["captureSessionId"],
        "sequence": sequence,
        "sourceTimeUs": max(0, int(source_time_us)),
        "capturedAt": captured_at,
        "mode": mode,
        "frame": frame_ref(registration["projectId"], frame),
    }
    return contracts.require_valid("ingest-envelope", env)


SessionState = Literal["requested", "dialing", "bridge_ready", "active", "ended", "failed"]


def capture_session(
    *,
    session_id: str,
    project_id: str,
    state: SessionState,
    started_at: str,
    consent_note: str,
    provider_call_id: str | None = None,
    caller_video: str = "unknown",
    agent_video: str = "unknown",
    ended_at: str | None = None,
    end_reason: str | None = None,
) -> dict[str, Any]:
    """CT-005 CaptureSession snapshot (HTTP allocation is `requested`, not answered)."""
    doc = {
        "schemaVersion": 1,
        "id": session_id,
        "projectId": project_id,
        "kind": "chert_facetime",
        "state": state,
        "providerCallId": provider_call_id,
        "consent": consent(consent_note, started_at),
        "capabilities": {"callerVideo": caller_video, "agentVideo": agent_video},
        "startedAt": started_at,
        "endedAt": ended_at,
        "endReason": end_reason,
    }
    problems = contracts.issues("capture-session", doc)
    terminal = state in ("ended", "failed")
    if terminal != (ended_at is not None):
        problems.append("endedAt: set exactly when state is ended or failed")
    if state == "active" and caller_video != "available":
        problems.append("capabilities.callerVideo: an active session must have callerVideo available")
    if problems:
        raise contracts.ContractViolation("capture-session", problems)
    return doc

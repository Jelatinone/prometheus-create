"""Write agent output to a folder the TypeScript gateway can replay.

Until the platform's ingest endpoint exists, the agent persists exactly what
it would send: the source registration, the capture-session snapshots, each
frame's bytes, and each envelope. lib/capture/replay-outbox.ts then stores the
frames and submits the records through the IngestionGateway port.

    outbox/<name>/
      source-registration.json
      capture-session.json         (latest CT-005 snapshot)
      frames/000000.jpg ...        (upright frame bytes)
      envelopes/000000.json ...    (IngestEnvelope per frame)
      log.ndjson                   (one line per decision, for evidence)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .frames import EncodedFrame

EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


class Outbox:
    def __init__(self, root: Path):
        self.root = Path(root)
        (self.root / "frames").mkdir(parents=True, exist_ok=True)
        (self.root / "envelopes").mkdir(parents=True, exist_ok=True)

    def _write_json(self, name: str, doc: Any) -> Path:
        path = self.root / name
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
        return path

    def registration(self, reg: dict[str, Any]) -> Path:
        return self._write_json("source-registration.json", reg)

    def session(self, snapshot: dict[str, Any]) -> Path:
        self.log({"event": "session", "state": snapshot["state"], "providerCallId": snapshot["providerCallId"]})
        return self._write_json("capture-session.json", snapshot)

    def frame(self, envelope: dict[str, Any], frame: EncodedFrame) -> Path:
        seq = envelope["sequence"]
        (self.root / "frames" / f"{seq:06d}.{EXTENSIONS[frame.mime_type]}").write_bytes(frame.data)
        return self._write_json(f"envelopes/{seq:06d}.json", envelope)

    def log(self, entry: dict[str, Any]) -> None:
        with (self.root / "log.ndjson").open("a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(entry) + "\n")

"""Minimal client for Chert's managed FaceTime API (stdlib only).

Base https://app.trychert.com/api/v1 (app.trychert.com/skills.md v0.2.0;
docs.trychert.com/facetime/outbound and calls-api for the call lifecycle):
  GET  /lines               lines and IDs (read-only; works before a line is issued)
  POST /calls               create (201 = allocated, NOT dialed or answered)
  GET  /calls/{id}          read
  GET  /calls/{id}/events   lifecycle events (also signalled by room metadata
                            `chert_bridge_ready`; start guidance only then)
  POST /calls/{id}/end      hang up (202 acknowledged; observe until terminal)
Every request sends `Authorization: Bearer ftk_…` and `X-Chert-Project-Id`;
every POST an `Idempotency-Key` (8-200 chars). Event payloads are not
documented, so events are kept raw.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from typing import Any

from .config import LiveConfig


class ChertError(RuntimeError):
    def __init__(self, status: int | None, message: str, body: Any = None):
        detail = body.get("error") if isinstance(body, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        text = detail.get("message") if isinstance(detail, dict) else None
        suffix = f" [{code}] {text}" if code else ""
        super().__init__(f"Chert API {status}: {message}{suffix}")
        self.status = status
        self.body = body
        #: Chert's machine-readable reason, e.g. "recipient_not_verified", "line_in_use".
        self.code: str | None = code


class ChertCalls:
    def __init__(self, config: LiveConfig, timeout_s: float = 20.0):
        self.config = config
        self.timeout_s = timeout_s

    def _request(self, method: str, path: str, body: Any = None, idempotency_key: str | None = None) -> Any:
        headers = {
            "Authorization": f"Bearer {self.config.chert_api_key}",
            "X-Chert-Project-Id": self.config.chert_project_id,
            "Accept": "application/json",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(self.config.chert_base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as res:
                text = res.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = text[:500]
            raise ChertError(e.code, str(e.reason), parsed) from None
        except urllib.error.URLError as e:
            raise ChertError(None, str(e.reason)) from None

    def lines(self) -> Any:
        """Read-only (facetime:read): verifies the key and project id and lists assigned lines."""
        return self._request("GET", "/lines")

    def create_outbound_call(self, *, participant_token: str, remote_participant_identity: str, idempotency_key: str, video: bool = True) -> dict[str, Any]:
        body = {
            "direction": "outbound",
            "mode": "customer_managed",
            "line_id": self.config.chert_line_id,
            "destination": self.config.destination,
            "destination_type": self.config.destination_type,
            "media": {"audio": True, "video": video},
            "livekit_url": self.config.livekit_url,
            "participant_token": participant_token,
            "remote_participant_identity": remote_participant_identity,
        }
        return self._request("POST", "/calls", body, idempotency_key)

    def get_call(self, call_id: str) -> Any:
        return self._request("GET", f"/calls/{call_id}")

    def events(self, call_id: str) -> Any:
        return self._request("GET", f"/calls/{call_id}/events")

    def end_call(self, call_id: str) -> Any:
        return self._request("POST", f"/calls/{call_id}/end", {}, f"end-{uuid.uuid4().hex}")


def event_list(payload: Any) -> list[dict[str, Any]]:
    """Events from the (undocumented) envelope: data as a list, or data.events / data.items."""
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        data = data.get("events") or data.get("items") or []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def event_name(event: dict[str, Any]) -> str:
    for key in ("type", "name", "event", "kind"):
        if isinstance(event.get(key), str):
            return event[key]
    return json.dumps(event)[:80]


TERMINAL_TOKENS = {"ended", "failed", "completed", "hangup", "canceled", "cancelled", "rejected", "declined", "busy", "unanswered", "terminated"}


def looks_terminal(name: str) -> bool:
    """Heuristic until Chert documents its call-ended event name."""
    import re

    return any(token in TERMINAL_TOKENS for token in re.split(r"[._\-\s]+", name.lower()))

"""Offline tests for the Chert Calls API client and config loading (urlopen stubbed; no network)."""
from __future__ import annotations

import io
import json
import os
import urllib.error

import pytest

from capture_agent import chert, config
from capture_agent.chert import ChertCalls, ChertError, event_list, event_name, looks_terminal

CONF = config.LiveConfig(
    chert_api_key="ftk_test_not_a_secret",
    chert_project_id="00000000-0000-0000-0000-000000000001",
    chert_line_id="00000000-0000-0000-0000-000000000002",
    destination="+15551234567",
    livekit_url="wss://example.livekit.cloud",
    livekit_api_key="key",
    livekit_api_secret="secret",
)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def capture_requests(monkeypatch, reply: dict | Exception):
    sent = []

    def fake_urlopen(req, timeout):
        sent.append(req)
        if isinstance(reply, Exception):
            raise reply
        return FakeResponse(json.dumps(reply).encode())

    monkeypatch.setattr(chert.urllib.request, "urlopen", fake_urlopen)
    return sent


def test_create_call_sends_documented_headers_and_body(monkeypatch):
    sent = capture_requests(monkeypatch, {"data": {"id": "call_123"}, "request_id": "req_1"})
    out = ChertCalls(CONF).create_outbound_call(participant_token="jwt", remote_participant_identity="agent", idempotency_key="cap_abc12345")
    assert out["data"]["id"] == "call_123"
    req = sent[0]
    assert req.full_url == "https://app.trychert.com/api/v1/calls" and req.get_method() == "POST"
    headers = {k.lower(): v for k, v in req.header_items()}
    assert headers["authorization"] == "Bearer ftk_test_not_a_secret"
    assert headers["x-chert-project-id"] == CONF.chert_project_id
    assert headers["idempotency-key"] == "cap_abc12345"
    body = json.loads(req.data)
    assert body == {
        "direction": "outbound",
        "mode": "customer_managed",
        "line_id": CONF.chert_line_id,
        "destination": "+15551234567",
        "destination_type": "phone",
        "media": {"audio": True, "video": True},
        "livekit_url": "wss://example.livekit.cloud",
        "participant_token": "jwt",
        "remote_participant_identity": "agent",
    }


def test_end_call_uses_its_own_idempotency_key(monkeypatch):
    sent = capture_requests(monkeypatch, {})
    ChertCalls(CONF).end_call("call_123")
    req = sent[0]
    assert req.full_url.endswith("/calls/call_123/end") and json.loads(req.data) == {}
    assert dict((k.lower(), v) for k, v in req.header_items())["idempotency-key"].startswith("end-")


def test_http_errors_become_chert_errors_with_body(monkeypatch):
    err = urllib.error.HTTPError("u", 409, "Conflict", {}, io.BytesIO(b'{"error":"idempotency mismatch"}'))
    capture_requests(monkeypatch, err)
    with pytest.raises(ChertError) as info:
        ChertCalls(CONF).get_call("call_123")
    assert info.value.status == 409 and info.value.body == {"error": "idempotency mismatch"}


def test_event_parsing_tolerates_undocumented_shapes():
    assert [event_name(e) for e in event_list({"data": [{"type": "bridge_ready"}, {"name": "call.ended"}]})] == ["bridge_ready", "call.ended"]
    assert event_list({"data": {"events": [{"event": "x"}]}}) == [{"event": "x"}]
    assert event_list({"data": None}) == []
    assert looks_terminal("call.ended") and looks_terminal("CALL_FAILED") and looks_terminal("hangup")
    assert not looks_terminal("bridge_ready") and not looks_terminal("call.started") and not looks_terminal("call.sending")


def test_destination_type_and_env_file(tmp_path, monkeypatch):
    assert CONF.destination_type == "phone"
    assert config.LiveConfig(**{**CONF.__dict__, "destination": "tester@example.com"}).destination_type == "email"
    env_file = tmp_path / ".env.local"
    env_file.write_text("# comment\nHK002_TEST_A=one # trailing comment\nHK002_TEST_B=\"two\"\nHK002_TEST_EMPTY=\n", encoding="utf-8")
    for k in ("HK002_TEST_A", "HK002_TEST_B", "HK002_TEST_EMPTY"):
        monkeypatch.delenv(k, raising=False)
    config.load_env_file(env_file)
    assert os.environ["HK002_TEST_A"] == "one" and os.environ["HK002_TEST_B"] == "two"
    assert "HK002_TEST_EMPTY" not in os.environ


def test_chert_key_is_only_sent_to_app_trychert_com(monkeypatch):
    monkeypatch.setenv("CHERT_BASE_URL", "https://evil.example.com/api/v1")
    with pytest.raises(SystemExit):
        config.chert_base_url()
    monkeypatch.setenv("CHERT_BASE_URL", "http://app.trychert.com/api/v1")
    with pytest.raises(SystemExit):
        config.chert_base_url()
    monkeypatch.delenv("CHERT_BASE_URL")
    assert config.chert_base_url() == "https://app.trychert.com/api/v1"


def test_lines_is_a_read_only_get(monkeypatch):
    sent = capture_requests(monkeypatch, {"data": [{"id": "line-1", "status": "ready"}]})
    out = ChertCalls(CONF).lines()
    assert sent[0].get_method() == "GET" and sent[0].full_url.endswith("/lines")
    assert event_list(out) == [{"id": "line-1", "status": "ready"}]


def test_masked_placeholders_and_bad_destinations_are_refused(monkeypatch):
    monkeypatch.setenv("HK002_MASKED", "•" * 32)
    monkeypatch.setenv("HK002_REAL", "abcDEF123")
    assert config.masked(("HK002_MASKED", "HK002_REAL")) == ["HK002_MASKED"]
    with pytest.raises(SystemExit):
        config.require_unmasked(("HK002_MASKED",))
    assert config.destination_problem("5551234567")  # no country code: never guessed
    assert config.destination_problem("+15551234567") is None
    assert config.destination_problem("tester@example.com") is None
    assert config.destination_problem("")

"""Live Chert FaceTime caller-frame capture (HK-002 / F-007 proof).

    python -m capture_agent.live check            # verify Chert key (read-only) + LiveKit room join; no call
    python -m capture_agent.live call [--seconds 90] [--project prj_…]

`call` flow (CT-005):
  1. Mint a room-scoped bridge token for Chert and a token for this agent.
  2. Join as the agent and publish audio. Play the bundled capture greeting
     after bridge_ready, avoiding Chert's silent-call timeout.
  3. POST /calls (201 = allocated only) -> session `requested`.
  4. Poll call events; `bridge_ready` -> session `bridge_ready`.
  5. Subscribe to the bridge's video track (caller camera); frames are rotated
     upright, selected (evidence on first frame / changed view / periodically,
     rate-limited previews), sequenced, built into IngestEnvelopes, validated
     against the JSON Schema and written to the outbox. First frame -> `active`.
  6. After --seconds of frames (or the caller hangs up), POST /calls/{id}/end,
     leave the room -> session `ended`. Replay the outbox into the gateway with
     `npx tsx lib/capture/replay-outbox.ts <outbox>`.

The outbox holds real caller frames: it is git-ignored and stays local.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

from . import config as cfg
from . import envelope as env
from .chert import ChertCalls, ChertError, event_list, event_name, looks_terminal
from .frames import encode_upright, signature, sha256_hash
from .outbox import Outbox
from .sequencer import FrameSelector, Sequencer

AGENT_IDENTITY = "prometheus-capture-agent"
OUTBOX_ROOT = Path(__file__).resolve().parents[1] / "outbox"
CONSENT_NOTE = "Consenting test participant (Cody's own/approved device) for the HK-002 Chert caller-frame proof"
ROTATION_CW = {0: 0, 1: 90, 2: 180, 3: 270}  # rtc.VideoRotation -> clockwise degrees


def tokens(url_key_secret: tuple[str, str, str], room: str) -> tuple[str, str, str]:
    from livekit import api

    _, key, secret = url_key_secret

    def mint(identity: str) -> str:
        grants = api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True)
        return api.AccessToken(key, secret).with_identity(identity).with_grants(grants).with_ttl(timedelta(minutes=30)).to_jwt()

    bridge_identity = f"chert-bridge-{uuid.uuid4().hex[:12]}"
    return mint(bridge_identity), mint(AGENT_IDENTITY), bridge_identity


def greeting_pcm() -> bytes:
    """Bundled locally synthesized speech; no voice-provider key or network needed."""
    path = Path(__file__).resolve().parents[1] / "assets" / "capture-ready.wav"
    with wave.open(str(path), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (48_000, 1, 2):
            raise ValueError("capture greeting must be 48 kHz mono 16-bit PCM")
        return audio.readframes(audio.getnframes())


async def publish_capture_audio(room, ready: asyncio.Event) -> asyncio.Task:
    """Greet only after bridge_ready: Chert ends calls that remain silent for 10 s."""
    from livekit import rtc

    source = rtc.AudioSource(48_000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("agent-audio", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    silence = rtc.AudioFrame(bytes(960 * 2), 48_000, 1, 960)  # 20 ms of s16 mono
    greeting = greeting_pcm()

    async def pump():
        cursor = 0
        announced = False
        while True:
            if ready.is_set() and cursor < len(greeting):
                if not announced:
                    print(f"{env.iso()}  playing capture greeting after bridge_ready")
                    announced = True
                chunk = greeting[cursor:cursor + 1920]
                cursor += len(chunk)
                await source.capture_frame(rtc.AudioFrame(chunk.ljust(1920, b"\x00"), 48_000, 1, 960))
            else:
                await source.capture_frame(silence)

    return asyncio.create_task(pump())


async def check() -> int:
    """No call is placed: Chert read-only list + LiveKit join/leave."""
    from livekit import rtc

    status = 0
    try:
        conf = cfg.load(require_line=False)
        calls = ChertCalls(conf)
        listed = calls.lines()
        lines = event_list(listed)
        print(f"OK   Chert API key + project accepted (GET /lines -> {len(lines)} line(s))")
        for line in lines:
            summary = {k: line.get(k) for k in ("id", "status", "state", "kind", "capabilities", "video", "caller_capture") if k in line}
            print(f"     line {json.dumps(summary)}")
        if conf.chert_line_id and not any(line.get("id") == conf.chert_line_id for line in lines):
            status = 1
            print("FAIL CHERT_LINE_ID is not among this project's lines")
        if not lines:
            print("     no line assigned yet: outbound calls are blocked until Chert releases one (LINE_NOT_READY)")
        if problem := cfg.destination_problem(conf.destination):
            print(f"WARN {problem} (calls will refuse to dial until fixed)")
    except ChertError as e:
        status = 1
        print(f"FAIL Chert API: {e}  body={json.dumps(e.body)[:300]}")
    except SystemExit as e:
        status = 1
        print(f"FAIL {e}")
    try:
        lk = cfg.livekit_only()
        room_name = f"hk002-check-{uuid.uuid4().hex[:8]}"
        _, agent_token, _ = tokens(lk, room_name)
        room = rtc.Room()
        await room.connect(lk[0], agent_token)
        print(f"OK   LiveKit join {room_name} as {room.local_participant.identity}")
        await room.disconnect()
    except (Exception, SystemExit) as e:  # noqa: BLE001 - report any connection failure plainly
        status = 1
        print(f"FAIL LiveKit: {type(e).__name__}: {e}")
    return status


async def call(seconds: float, project_id: str, max_wait_bridge_s: float, max_wait_frame_s: float) -> int:
    from livekit import rtc

    conf = cfg.load()
    if not conf.chert_line_id:
        raise SystemExit("CHERT_LINE_ID is empty: no line has been issued yet (LINE_NOT_READY)")
    calls = ChertCalls(conf)
    session_id = env.new_id("captureSession")
    room_name = f"hk002-{uuid.uuid4().hex[:10]}"
    bridge_token, agent_token, bridge_identity = tokens((conf.livekit_url, conf.livekit_api_key, conf.livekit_api_secret), room_name)
    started_at = env.iso()
    run = OUTBOX_ROOT / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{session_id[4:12]}"
    box = Outbox(run)
    registration = env.chert_source_registration(project_id=project_id, capture_session_id=session_id, captured_at=started_at, consent_note=CONSENT_NOTE)
    box.registration(registration)
    box.log({"event": "start", "room": room_name, "bridgeIdentity": bridge_identity, "agentIdentity": AGENT_IDENTITY, "sessionId": session_id})

    state = {"call_id": None, "session": "requested", "frames": 0, "evidence": 0, "previews": 0, "first_frame_at": None, "ended": False, "caller_video": "unknown"}

    def snapshot(new_state: str, end_reason: str | None = None):
        state["session"] = new_state
        terminal = new_state in ("ended", "failed")
        box.session(
            env.capture_session(
                session_id=session_id,
                project_id=project_id,
                state=new_state,
                started_at=started_at,
                consent_note=CONSENT_NOTE,
                provider_call_id=state["call_id"],
                caller_video=state["caller_video"],
                ended_at=env.iso() if terminal else None,
                end_reason=end_reason,
            )
        )
        print(f"{env.iso()}  session {session_id} -> {new_state}{f' ({end_reason})' if end_reason else ''}")

    room = rtc.Room()
    bridge_ready = asyncio.Event()
    selector, sequencer = FrameSelector(), Sequencer()
    video_tasks: list[asyncio.Task] = []

    async def consume(track: rtc.Track, participant: rtc.RemoteParticipant):
        stream = rtc.VideoStream(track, format=rtc.VideoBufferType.RGBA)
        try:
            async for event in stream:
                if state["ended"]:
                    break
                frame = event.frame
                img = Image.frombytes("RGBA", (frame.width, frame.height), bytes(frame.data))
                rotation = ROTATION_CW.get(int(event.rotation), 0)
                sig = signature(img)
                # Hash the raw pixels so frozen frames are skipped before encoding.
                decision, why = selector.decide(event.timestamp_us, sig, sha256_hash(bytes(frame.data)))
                state["frames"] += 1
                if decision == "skip":
                    continue
                encoded = encode_upright(img, rotation, max_edge=2048)
                sequence, source_time = sequencer.assign(event.timestamp_us)
                envelope = env.ingest_envelope(
                    registration=registration, frame=encoded, sequence=sequence, source_time_us=source_time, captured_at=env.iso(), mode=decision
                )
                box.frame(envelope, encoded)
                box.log({"event": "frame", "sequence": sequence, "mode": decision, "why": why, "sourceTimeUs": source_time,
                         "width": encoded.width, "height": encoded.height, "rotation": rotation, "participant": participant.identity, "track": track.name})
                state["evidence" if decision == "evidence" else "previews"] += 1
                if state["first_frame_at"] is None:
                    state["first_frame_at"] = time.monotonic()
                    state["caller_video"] = "available"
                    snapshot("active")
                if decision == "evidence":
                    print(f"{env.iso()}  evidence seq {sequence} t={source_time / 1e6:.2f}s {encoded.width}x{encoded.height} ({why})")
        finally:
            await stream.aclose()

    @room.on("track_subscribed")
    def on_track(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        box.log({"event": "track_subscribed", "participant": participant.identity, "track": track.name, "kind": int(track.kind), "source": int(publication.source)})
        print(f"{env.iso()}  subscribed {participant.identity} / {track.name} kind={int(track.kind)}")
        if track.kind == rtc.TrackKind.KIND_VIDEO and participant.identity == bridge_identity:
            video_tasks.append(asyncio.ensure_future(consume(track, participant)))

    @room.on("track_muted")
    def on_muted(participant, publication):
        box.log({"event": "track_muted", "participant": participant.identity, "track": publication.name})

    @room.on("participant_disconnected")
    def on_left(participant: rtc.RemoteParticipant):
        box.log({"event": "participant_disconnected", "participant": participant.identity})
        if participant.identity == bridge_identity:
            state["ended"] = True

    @room.on("room_metadata_changed")
    def on_metadata(old: str, new: str):
        # skills.md: Chert marks FaceTime readiness with the room metadata key `chert_bridge_ready`.
        box.log({"event": "room_metadata_changed", "metadata": new[:500]})
        if "chert_bridge_ready" in (new or ""):
            try:
                ready = bool(json.loads(new).get("chert_bridge_ready"))
            except (ValueError, AttributeError):
                ready = False
            if ready:
                bridge_ready.set()
                if state["session"] == "requested":
                    snapshot("bridge_ready")

    await room.connect(conf.livekit_url, agent_token)
    pump = await publish_capture_audio(room, bridge_ready)
    print(f"{env.iso()}  agent in room {room_name}; placing call to the consenting test device")

    exit_code = 0
    try:
        created = calls.create_outbound_call(participant_token=bridge_token, remote_participant_identity=AGENT_IDENTITY, idempotency_key=session_id)
        call_data = created.get("data", created) if isinstance(created, dict) else {}
        state["call_id"] = call_data.get("id")
        box.log({"event": "call_created", "callId": state["call_id"], "requestId": created.get("request_id") if isinstance(created, dict) else None})
        snapshot("requested")
        print(f"{env.iso()}  Chert call {state['call_id']} allocated (HTTP 201 is not an answered call)")

        seen: set[str] = set()
        deadline_bridge = time.monotonic() + max_wait_bridge_s
        while not state["ended"]:
            await asyncio.sleep(1.0)
            try:
                for ev in event_list(calls.events(state["call_id"])):
                    key = json.dumps(ev, sort_keys=True)
                    if key in seen:
                        continue
                    seen.add(key)
                    name = event_name(ev)
                    box.log({"event": "chert_event", "name": name, "raw": ev})
                    print(f"{env.iso()}  chert event: {name}")
                    if "bridge_ready" in name:
                        bridge_ready.set()
                        if state["session"] == "requested":
                            snapshot("bridge_ready")
                    if looks_terminal(name):
                        state["ended"] = True
            except ChertError as e:
                box.log({"event": "events_error", "status": e.status, "message": str(e)})
            now = time.monotonic()
            if state["first_frame_at"] is None:
                if state["session"] == "requested" and now > deadline_bridge:
                    raise TimeoutError(f"no bridge_ready within {max_wait_bridge_s:.0f}s (LINE_NOT_READY or unanswered)")
                if state["session"] == "bridge_ready" and now > deadline_bridge + max_wait_frame_s:
                    raise TimeoutError(f"bridge ready but no caller video within {max_wait_frame_s:.0f}s (CALLER_CAPTURE_UNAVAILABLE?)")
            elif now - state["first_frame_at"] >= seconds:
                break
    except (ChertError, TimeoutError) as e:
        exit_code = 1
        box.log({"event": "error", "message": str(e), "body": getattr(e, "body", None)})
        print(f"{env.iso()}  ERROR {e}")
    finally:
        state["ended"] = True
        if state["call_id"]:
            try:
                calls.end_call(state["call_id"])
                box.log({"event": "end_requested", "callId": state["call_id"]})
                print(f"{env.iso()}  end requested for call {state['call_id']}")
                for _ in range(10):  # observe until a terminal event (or give up after ~10 s)
                    await asyncio.sleep(1.0)
                    names = [event_name(ev) for ev in event_list(calls.events(state["call_id"]))]
                    if any(looks_terminal(n) for n in names):
                        box.log({"event": "terminal_observed", "names": names[-5:]})
                        break
            except ChertError as e:
                box.log({"event": "end_error", "message": str(e), "body": e.body})
        pump.cancel()
        for t in video_tasks:
            t.cancel()
        await asyncio.gather(pump, *video_tasks, return_exceptions=True)
        await room.disconnect()
        # Frame capture and the provider's terminal call status are separate facts.
        # A worker can deliver usable frames and still report a failed call.
        provider_status = None
        if state["call_id"]:
            try:
                ended = calls.get_call(state["call_id"])
                ended = ended.get("data", ended)
                provider_status = ended.get("status")
                box.log({"event": "provider_terminal", "status": provider_status, "reason": ended.get("terminal_reason")})
            except ChertError:
                box.log({"event": "provider_terminal", "status": "unconfirmed"})
        state["provider_terminal_status"] = provider_status
        failed = not state["first_frame_at"] or provider_status == "failed"
        if failed:
            exit_code = 1
        snapshot("failed" if failed else "ended", "provider reported failed after delivering frames" if state["first_frame_at"] and failed else "capture finished" if state["first_frame_at"] else "no caller frames")
    summary = {k: state[k] for k in ("call_id", "frames", "evidence", "previews", "caller_video", "provider_terminal_status")} | {"room": room_name, "sessionId": session_id, "sourceId": registration["id"], "projectId": project_id, "outbox": str(run)}
    # Frame-selection counts by reason (HK-011 CP-022), including near-duplicates dropped.
    summary["selection"] = dict(selector.stats)
    (run / "selection-stats.json").write_text(json.dumps(summary["selection"], indent=2) + "\n", encoding="utf-8")
    (run / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return exit_code if state["first_frame_at"] else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="verify credentials without placing a call")
    c = sub.add_parser("call", help="place one outbound call and capture caller frames")
    c.add_argument("--seconds", type=float, default=60.0, help="capture duration after the first caller frame")
    c.add_argument("--project", default=None, help="project id the frames belong to (default: new prj_ id)")
    c.add_argument("--wait-bridge", type=float, default=90.0, help="seconds to wait for bridge_ready")
    c.add_argument("--wait-frame", type=float, default=30.0, help="seconds after bridge_ready to wait for caller video")
    args = p.parse_args()
    if args.cmd == "check":
        return asyncio.run(check())
    return asyncio.run(call(args.seconds, args.project or env.new_id("project"), args.wait_bridge, args.wait_frame))


if __name__ == "__main__":
    raise SystemExit(main())

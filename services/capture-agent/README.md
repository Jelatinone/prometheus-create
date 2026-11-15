# Capture agent (Python)

Chert FaceTime caller video → LiveKit room → **CT-002** records. One call becomes one `chert_facetime` live-stream `SourceRegistration`; each selected caller frame becomes an `IngestEnvelope`, validated against `lib/contracts/json-schema/*.schema.json` before it leaves the agent. The agent writes an atomic **outbox**; `lib/capture/call-http.mts` follows it into persistent authenticated ingestion. `replay-outbox.ts` remains the in-memory reference test.

## Setup

Windows (native, tested with Python 3.13):

```bash
py -3.13 -m venv services/capture-agent/.venv
services/capture-agent/.venv/Scripts/python -m pip install -e "services/capture-agent[live,dev]"
```

Linux or WSL: the same with `python3 -m venv` and `.venv/bin/python`. The agent uses Chert's managed Calls API over HTTPS and the LiveKit Python SDK; it does not require the Chert CLI.

## Secrets (`.env.local` at the repo root, git-ignored)

| Key | Where it comes from |
| --- | --- |
| `CHERT_API_KEY` | Chert app → Developer → Project API keys (`ftk_…`, scopes `facetime:read` and `facetime:write`) |
| `CHERT_PROJECT_ID` | Chert project UUID |
| `CHERT_LINE_ID` | The assigned FaceTime line. It needs outbound video **and** caller-camera capture enabled; confirm with Chert. |
| `CHERT_TEST_DESTINATION` | The consenting test device: `+15551234567` or an Apple ID email |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Your LiveKit Cloud project settings (or keys Chert provided) |

## Commands (run from `services/capture-agent`)

```bash
.venv/Scripts/python -m pytest -q
```

```bash
.venv/Scripts/python -m capture_agent.live check
```

```bash
.venv/Scripts/python -m capture_agent.live call --seconds 60
```

```bash
.venv/Scripts/python -m capture_agent.golden
```

- `check` places no call: it runs a read-only `GET /calls` (verifying the key and project) and joins and leaves a LiveKit room.
- `call` places one outbound call to `CHERT_TEST_DESTINATION`. It writes `outbox/<run>/` (real caller frames; git-ignored, never committed), then ends the call.
- `golden` regenerates `fixtures/capture/agent-outbox.synthetic` (generated test frames; not a real call).

Replay a run into the gateway (from the repo root):

```bash
npx tsx lib/capture/replay-outbox.ts services/capture-agent/outbox/<run>
```

## Behavior and limits

### Persistent HTTP ingestion (V2)

From the project root, set `INGEST_API_URL` to the running app origin,
`INGEST_ACCESS_TOKEN` to a short-lived Supabase user access token, and
`CAPTURE_PYTHON` to the Python executable in the existing agent environment.
The token must belong to the owner of the target project. Keep it in the
environment, never command arguments or committed files. Existing Chert and
LiveKit credentials stay in `.env.local`; `CHERT_LINE_ID` must name the assigned line.

```bash
npx tsx lib/capture/call-http.mts --project prj_YOUR_PROJECT --seconds 35
```

This starts the existing agent and follows its outbox through `HttpBackend`
and `PlatformBlobStore` while the call runs. It creates an empty capture
project only if the requested project does not exist. Replaying a saved run:

```bash
npx tsx lib/capture/replay-http.mts services/capture-agent/outbox/RUN
```

Evidence frames retain their timestamps; delayed previews are discarded under
the existing freshness limit. The final `http-ingest-result.json` records
accepted/duplicate frames and persistent read-back. The editor's Reconstruct
panel lists those frames. No audio model or additional provider keys are needed.
This is a local worker, not a hosted deployment.

Chert ends silent calls unless the agent greets within ten seconds of
`bridge_ready`. The bundled `assets/capture-ready.wav` is locally synthesized
48 kHz mono speech, played once after that readiness signal (not on room join).
Regenerate it on Windows with `make-greeting.ps1`. The agent publishes no outgoing
camera track; return video is outside this ingest test. Capture success and
provider terminal status are reported separately; a failed provider call never
becomes a successful session merely because some frames arrived.

- Frame selection: the first frame, a changed view (signature difference ≥ 18), and a periodic anchor every 5 s are `evidence`. Previews are capped at 2 fps and frames identical to the previous one are skipped. Sequence numbers are assigned only to frames that are sent.
- Frames are rotated upright using LiveKit's frame rotation and stored as JPEG (long edge ≤ 2048 px).
- Lifecycle (CT-005): `requested` (HTTP 201 means allocated, not answered) → `bridge_ready` (Chert event) → `active` (first caller frame) → `ended` or `failed`.
- Chert does not document its event payload schema or a call-ended event name. The agent logs raw events and treats tokens such as `ended`/`failed` as terminal. Verify this against a real call.
- Chert notes that caller capture may include FaceTime UI (controls, names, self-preview) and is not always a raw camera feed.

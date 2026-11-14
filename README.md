# prometheus-create

Capture a scene, make its objects editable, and create another take. Hackathon build for HackUTA 2026; product intent, contracts, and gates live in [PLAN.md](PLAN.md).

## Setup

Requires Node.js 22.18 or later.

```bash
git submodule update --init --recursive
```

```bash
npm ci
```

## Verify

```bash
npm run verify
```

Runs typecheck, lint, unit and conformance tests, and a production build, then prints a pass/fail evidence table (saved to `.verify/report.md`). On a lane branch it first checks that only the lane's owned paths changed. Add `-- --quick` to skip the build.

```bash
npm run dev
```

Open <http://localhost:3000/lab>, the verification lab:

- **Contract fixtures**: every golden fixture validates, every invalid case is rejected where expected.
- **Contract validator** (`/lab/validate`): paste or drop any JSON and check it against a contract.
- **GLB inspector** (`/lab/glb`): dimensions, triangles, warnings, and a 3D view of any `.glb`.
- **Lane labs** (`/lab/editor`, `/lab/platform`, `/lab/capture`): each lane's hand-checkable demo.

Command-line equivalents: `npm run validate -- list`, `npm run validate -- auto <file.json>`, `npm run validate -- glb <file.glb>`.

## Layout

| Path | What |
| --- | --- |
| `lib/contracts/` | Shared zod contracts (scene, source, ingestion, revision, export, proposals), ports, generated JSON Schema |
| `lib/reference/` | In-memory reference backend implementing the ports |
| `lib/assets/` | GLB inspection and fixture writer |
| `fixtures/` | Golden and invalid contract fixtures; `public/fixtures/axis-box.glb` |
| `tests/` | Contract, conformance, GLB, and lane-ownership tests |
| `app/lab/` | Verification lab |
| `lanes.json`, `docs/LANES.md` | Parallel lane ownership and protocol |
| `docs/changes/` | One task note per task (assignment, plan, evidence) |
| `toolkit/` | Pinned hackathon-toolkit submodule (workflows and formats) |

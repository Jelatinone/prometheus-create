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

Check a file by hand against the contracts:

```bash
npm run validate -- auto fixtures/contracts/take-manifest.original.json
```

`npm run validate -- list` names every contract; `npm run validate -- <contract> <file.json>` checks any JSON (a saved manifest, an export manifest, a capture-agent payload); `npm run validate -- glb <file.glb>` prints a mesh's dimensions, triangle count, and warnings.

Run the app with `npm run dev` and open <http://localhost:3000>.

## Layout

| Path | What |
| --- | --- |
| `lib/contracts/` | Shared zod contracts (scene, source, ingestion, revision, export, proposals), ports, generated JSON Schema |
| `lib/reference/` | In-memory reference backend implementing the ports |
| `lib/assets/` | GLB inspection and fixture writer |
| `fixtures/` | Golden and invalid contract fixtures; `public/fixtures/axis-box.glb` |
| `tests/` | Contract, conformance, GLB, and lane-ownership tests |
| `lanes.json`, `docs/LANES.md` | Parallel lane ownership and protocol |
| `docs/changes/` | One task note per task (assignment, plan, evidence) |
| `toolkit/` | Pinned hackathon-toolkit submodule (workflows and formats) |

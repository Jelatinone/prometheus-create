# Prometheus::create — final working plan

**Capture a scene. Edit its objects. Create another take.**

Active continuation **v8** (below) extends **v7** replaces earlier ordering and UI assumptions. [The full v6 plan is archived](docs/archive/PLAN-v6-before-final-window.md); task notes retain detailed implementation evidence. Read this plan and the assigned note, not obsolete track instructions, when taking over.

```yaml
schema_version: 2
project_name: "Prometheus::create"
event_name: "HackUTA 2026"
project_status: "building"
plan_version: 8
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
updated_at: "2026-11-15T08:00:00-06:00"
timezone: "America/Chicago"
code_start: "2026-11-14T12:00:00-06:00"
code_end: "2026-11-15T10:00:00-06:00"
feature_freeze: "2026-11-15T08:00:00-06:00"
submission_deadline: null
release_owner: "Cody - integration, review, demo and submission owner"
stable_branch: "production"
base_release: "STABLE-V2 (local annotated tag at 06e97e7)"
current_stable_release: "STABLE-V3 (local annotated tag at c88214d; never retarget)"
```

The 08:00 feature freeze and 10:00 finish are **Cody's working cutoffs**, not a newly verified organizer submission deadline. Earlier event-clock discrepancies remain in the archive; Cody owns official deadline/submission confirmation. Do not treat unknown rules as publication or eligibility approval.

## 1. Product contract

### Current continuation v8 — final nits and one bounded experiment (08:00–10:00)

Cody (2026-11-15 ~07:55) made Claude the primary agent on production after STABLE-V3.1 (local tag at 964d0cc). Conservative usage; each item lands as its own scoped commit and keeps the journey runnable.

| ID | Kind | Outcome | Acceptance | State |
| --- | --- | --- | --- | --- |
| CP-026 | UI nit | Timeline key diamonds sit on the scrubber track at their frame | Keys at frame 0 and the last frame line up with the thumb at those frames | ready_for_review (verify passes at ec062b2, 341 tests) |
| CP-027 | UI nit | Viewport hints ("no objects", "no visible splat/layers") become a top toast that fades and has a close (x) | No message text sits in the grid; toasts dismiss on x or after a few seconds | ready_for_review (verify passes at ec062b2, 341 tests) |
| CP-028 | UI + API | Click the project name in the editor header to rename it | `PATCH /api/projects/[projectId]` {title}; `ProjectRepository.renameProject` in both backends with a conformance test; owner-only | ready_for_review (verify passes at ec062b2, 341 tests) |
| CP-029 | Behaviour | Splats arrive with generated objects and show at once, separate from meshes | Every SAM 3D job (including live-call jobs) already returns a splat; generated objects now attach it switched on (53ba7c7). A separate per-frame splat job on ingest was not added (each is a paid call) | ready_for_review |
| CP-030 | Experiment | Whole-scene splat (walls, floor) from several frames | SAM 3D rejects floors. Lyra 2 is not reachable on fal (no endpoint ID resolves). MoGe-2 (one frame, metric) gives a clean textured relief, convincing only from the camera's side. fal-ai/vggt-1b fuses all frames of a capture (poses + coloured cloud; cold start 100-210 s, run ~10 s): converted to S1 splats by `lib/reconstruction/scene-splat.ts` (drops letterbox-black and outlier points); round-table call -> 99,089 splats, recognisable but rotated (VGGT's up is the first camera) and unscaled. Kept as `scripts/scene-splat.mts` (CLI, paid); not wired into the editor. Next: level with the camera poses, scale from MoGe metric depth, crop letterbox before upload | experiment kept as a tool |
| CP-031 | Behaviour | Multi-frame mesh ("From video" on a found object) | Unmasked frames from different captures gave a poor blob; masked cut-outs of one object from one capture gave a recognisable pedestal table. Built (44d3746): SAM 3 masks in 4 frames in parallel, sharp cut-outs, fal-ai/trellis/multi; server test 4 views, 48 s, 5,150 triangles (~$0.04). Single request, no job record | ready_for_review |
| CP-032 | UI cleanup | Right pane is configuration only: no camera chooser with one camera, no "Refresh capture info", no Geometry/Evidence blocks or manual .ply upload in the inspector; the Source tab names the video, not frame ranges | Typecheck, lint, editor tests | done |
| CP-033 | Behaviour | Find objects without a typed prompt, from the toolbar | Tested (~$0.02): SAM 3 returns nothing for a multi-object sentence or "furniture"; Florence-2 detection names the frame's objects (round table frame: chair), then one SAM 3 find per name (chair: 11 masks). Built as the Generate-mode toolbar action; typed find kept for refining. Running it automatically during the live call stays a follow-up | ready_for_review (verify passes at 375de44) |
| CP-034 | UI | Camera capture actions in the toolbar (Capture length, Follow capture); the pane only picks the capture | Checked on the dev server | ready_for_review (verify passes at 375de44) |

CP-029 to CP-031 are paid-provider experiments: before any call, Claude reports candidate models, price and expected latency, and Cody approves the spend (fal budget ~$10 total). If no candidate fits the remaining time, they stay proposals for after the event. CP-025 (clip ranges) stays parked on `wip/CP-025-clips`.

### Current continuation v7 — sequential agents, finish by 10:00 A.M.

#### Objective

Keep the working capture → Generate → edit/fork → save → export journey. Spend the remaining feature window on **Layers and usability**, then protect the final two hours for stability and polish.

#### Scope and exclusions

One agent at a time, directly on **production** in this root checkout. No parallel tracks, worktrees, speculative providers, new backend architecture or contract expansion for UI rearrangement. Completed camera/video behavior stays intact. No automatic push, tag, deploy or paid fal/Chert call.

#### Inputs and baseline

`f317b7f0d2f8` passes all verifier gates: **329 tests, typecheck, lint and build**. CP-019 unified export and CP-020 editable camera/duration/video are ready for review (HK-012). Real call ingestion/return-video proofs already exist (HK-011); don't repeat them just for this UI work. Cody confirmed the layout: **fixed floating mode icons on the left, details on the right, context actions at the bottom**.

#### Ordered steps

The order is deliberate: **each increment works before the next begins**. A partially redesigned surface must never depend on a later step to restore its controls. Time boxes are estimates; protect 08:00–10:00 even if a feature runs late.

| Step | Outcome | Task IDs | Owned paths | Dependencies | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 — 25 min | CP-018: Layers button, independent Mesh/Splat toggles, either/both/none. Use the existing toolbar initially; no dependency on the redesign | HK-012 | Editor/viewport/model and related tests | Verified current base | Relevant checks and one brief layer-toggle smoke; optional hover only if it fits |
| 2 — 20 min | CP-016 A: make video/Generate frame selection usable; diagnose retained-batch lock versus seek handling; preserve durable jobs | HK-013 | CapturePanel, ReconstructPanel, narrow browser seek helper and tests | Current frame/capture APIs | One small video, choose two different times/frames, no provider submit |
| 3 — 60 min | CP-016 B: Object/Camera/Generate/Source icon rail; right pane contains details; bottom toolbar contains actions for the current mode | HK-013 | App/editor components; local UI state only | Existing handlers; step 1 remains usable | Existing actions remain reachable, keyboard/focus smoke; no backend rewiring |
| 4 — 30 min | CP-016 C: simplify Generate into choose frame → find/select objects → generate → add; make changing frame/new selection obvious | HK-013 | ReconstructPanel and related UI/model tests | Existing batch/job semantics | Existing finished jobs or mocks; no repeated/new paid submits |
| 5 — 10 min + remaining buffer | CP-016 D: remove tutorial paragraphs, duplicate controls and overexplained dialogs project-wide; finish by 08:00 | HK-013 | App/components copy and presentation | Each prior increment already works | One short core-journey walkthrough; labels/tooltips for necessary details |
| 6 — 08:00–08:45 | CP-017: integrated verification and bounded security/stability triage | HK-014 | Actual defects only | Stable committed feature base | One full npm run verify, auth/asset/spend review; target checks for fixes |
| 7 — 08:45–09:30 | Stability and polish: fix blockers, tidy layout/focus, rehearse the core journey with saved assets | HK-014 | Bounded repairs/polish | No new feature dependency | One working journey; reopen a saved project and representative export |
| 8 — 09:30–10:00 | Final buffer, exact-revision handoff and known-good fallback; Cody's demo/submission work | HK-014 / Cody | Notes, artifacts and critical defects only | Working local build | Clean tree, recorded checks/limits, usable fallback; publication only if requested |

#### Acceptance and verification

The permanent timeline goes away. Keep **compact playback/seek and key actions in a toolbar popover**; retain camera/key data, undo, save/fork and exports. Camera keying belongs in the Camera mode bottom tools. Object mode gets selection/transform actions; Generate gets a concise frame/find/generate/add flow; Source gets capture/reference actions. Global Layers/view controls remain reachable in every mode. Right-hand details are concise and scrollable; no second always-open tools pane. Use the established serif/vermilion palette and HeroIcons.

Routine feature validation is **targeted and short**, per section 6. Do not benchmark/re-export every asset or run the full suite after each cosmetic edit. The next full integrated gate belongs to 08:00–10:00. UI changes must not silently discard jobs, resubmit paid work, alter render cameras through free orbit, or replace real provider states with invented progress.

#### Risks and rollback

If time slips, cut optional hover flourishes and animation/editor extras first. **Do not cut dual Layers toggles or the reserved stability window.** Full per-object timelines/clip ranges, advanced export screens, capture coaching and agentic playback are deferred. Roll back only an unready scoped increment to the last working commit; preserve project/revision history and immutable assets.

#### Decisions requiring approval

Current layout, priorities, sequential execution, lighter feature checks and this time budget are explicitly authorized by Cody. A new shared contract/backend, paid generation/call, publication or tag/deploy still needs the existing responsible-owner approval. Implementation task state may reach ready_for_review; Cody owns final acceptance.

## 2. Event requirements and proofs

| Requirement ID | Official source and exact clause | Verified at | Constraint/proof | Owner | State | Evidence/limitation |
| --- | --- | --- | --- | --- | --- | --- |
| RULE-001 | Prior organizer material and unresolved clock discrepancy: archived v6 section 2 | Earlier planning; not refreshed in this pass | Keep truthful asset/AI/provider disclosures; verify actual submission deadline separately | Cody | in_progress | No new eligibility or submission claim from this work plan |

| Track ID | Exact prompt clause/source | Essential technology/capability | Proof scene | Current state | Gap/limitation |
| --- | --- | --- | --- | --- | --- |
| SP-001 | Chert track sources retained in archived v6 | Actual call capture and return video | Existing tested calls | tested | HK-011 CP-022/023; later quality tweaks not all re-called |
| SP-002 | Tiger Data sources retained in archived v6 | Durable projects/revisions/jobs | Save, reload and fork | tested | Live platform tests pass; no new persistence system |
| General / FaZe | Prior target selection; full FaZe requirements still require checking | Captured scene edited into another take/clip | Existing mesh/splat/editor/export journey | in_progress | Do not make unverified challenge-specific claims |

## 3. Scope tiers and release gates

| ID | Tier | Outcome | Dependencies | Measurable acceptance | Owner | State |
| --- | --- | --- | --- | --- | --- | --- |
| CP-018 | CORE | Mesh/Splat Layers, either/both/none | Existing renderer | Working independent view toggles | HK-012 | planned |
| CP-016 | CORE | Simple mode/tool layout, usable frame picking, concise Generate and copy | Existing handlers | Each subpass leaves the journey runnable | HK-013 | planned |
| CP-017 | CORE | Protected stability/security/polish window | Committed feature base | One full gate plus bounded defect fixes | HK-014 | planned |
| CP-019 / CP-020 | RETAIN | Unified export, camera path and editable duration/video | Current production | Verified output/persistence; preserve during UI moves | HK-012 | ready_for_review |
| CP-025 | DEFER | Full per-object timeline, clip visibility ranges and advanced export screen | Would require more UI/model work | Conflicts with removing permanent timelines and remaining capacity | Cody | deferred |
| CP-024 / CP-021 | DEFER | Coaching and agentic playback | New work beyond the core | No build in this window; agentic design still needs approval | Cody | deferred |

STABLE-V3 is the **local annotated tag at c88214d** (promoted at Cody's request after the full verifier passed there, 338 tests). STABLE-V2 stays at 06e97e7. Never retarget either. No remote publication is implied.

## 4. System architecture

Keep the present architecture. UI work reuses its handlers and contracts.

| Module/owner | Responsibility | Inputs/outputs | Public contract ID | Mock/live compatibility |
| --- | --- | --- | --- | --- |
| lib/contracts | Scene/take, capture, persistence, export and call schemas/ports | Shared typed documents and Result values | CT-001..005 | Existing schemas plus approved smooth interpolation |
| Platform | TigerData metadata, Supabase identity/private assets; HttpBackend | Existing project/asset/job/ingest routes | CT-002/003 | MemoryBackend is the reference; platform is already live |
| Capture / generation | Upload/camera/video/Chert evidence and durable single-shot provider jobs | Source time in integer microseconds | CT-002/005 | Reuse existing assets/jobs; no new paid proof needed |
| Editor / renderer | Objects, mesh/splat appearance, free view, active render camera, keys/undo/fork | Meters, +Y up, quaternion [x,y,z,w]; take frames at rational rate | CT-001/003 | UI mode/layer settings are view state |
| Export | PNG, GLB, project ZIP and local WebCodecs video | One export entry; exact take frames and actual supported MIME | CT-004 | Mediabunny 1.66.0; silent video up to 1280 px long edge, 96 MiB local buffer guard |

**Camera rule:** one active render camera per take; free navigation does not edit it. Smooth position interpolation is an approved additive key option, with quaternion slerp and linear scale. Capture length does not invent camera motion; seed only actual camera estimates. Older takes remain compatible; new smooth takes need the updated app. Full contract/reference/fixture details remain in lib/contracts and archived v6 section 4.

## 5. Work packages and checkpoints

**Active branch/workspace: production, this root checkout, one agent at a time.** The old lane branch names below are retained only for registry/history compatibility; they do not authorize parallel work. Next: CP-018 / HK-012, then HK-013 subpasses A–D, then the protected HK-014 window.

| Task ID | Checkpoint ID | Branch | Owner | Owned paths | Dependency IDs | Acceptance / test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HK-001 | CP-001 | feat/HK-001-foundation | Cody | App scaffold, package/lock files, lib/contracts, PLAN.md, docs/DECISIONS.md, toolkit adoption | None | Runnable shell, GLB fixture, actual commands recorded; rules and account access checked. | merged |
| HK-002 | CP-001 | feat/HK-002-risk-proofs | Cody | services/capture-agent, isolated provider adapters, docs/changes/HK-002.md | HK-001 | Real Chert caller frame and real image-to-mesh request; record failures and cut decision. | planned |
| HK-003 | CP-002 | feat/HK-003-ingest-persist | Cody | app project/capture routes, lib/server, db, auth/storage | HK-001, HK-002 | Upload and Chert frame share CT-002; authenticated save/reload and unauthorized rejection. | planned |
| HK-004 | CP-002 | feat/HK-004-editor | Cody | components/editor, lib/scene, editor state | HK-003 | Select, lasso, transform, undo, source reference, mesh acceptance. | planned |
| HK-005 | CP-003 | feat/HK-005-takes-export | Cody | Take commands, exporters, export panel, journey tests | HK-004 | Original/fork isolation; PNG + GLB reopen; exact revision saved. | planned |
| HK-006 | CP-003 | feat/HK-006-demo-proof | Cody | Integration fixes, sponsor evidence, docs/demo, submission draft | HK-005 | STABLE-V1 and, where actually proven, V2; first usable recording. | planned |
| HK-007 | CP-004 | chore/HK-007-early-release | Cody | Release records, docs/demo, final bug fixes, submission artifacts | HK-006 | RC-1 and earlier submission readiness; receipt after actual submit. | planned |
| HK-008 | CP-005 | feat/HK-008-motion | Cody | Minimal timeline, animation, optional Rapier, video export | HK-007 | Only after confirmed extra time: short take, basic motion/physics and supported video playback. | planned |
| HK-009 | CP-005 | feat/HK-009-appearance | Cody | Optional Spark adapter or return-preview adapter, targeted checks | HK-008 | Choose at most one stretch: aligned splats OR duplex FaceTime preview. | planned |
| HK-010 | CP-006 | chore/HK-010-final | Cody | Release, evidence, video, submission records | HK-008 | Confirmed-window final regression, final artifacts, receipt and rehearsal. | planned |
| HK-011 | CP-007..010, CP-021..024 | feat/HK-011-track-a | Historical Track A; no active agent | Existing capture/reconstruction; docs/changes/HK-011.md | Historical | Existing call proofs preserved; coaching/agentic additions deferred | ready_for_review |
| HK-012 | CP-011..015, CP-018..021, CP-025 | feat/HK-012-track-b | Current linear editor agent on production | components/editor/**, lib/scene/**, lib/editor/**, lib/export/**, tests/editor/**, tests/scene/**, docs/changes/HK-012.md | Existing verified production | CP-019/020 ready; next CP-018 Layers; future feature checks per section 6 | ready_for_review |
| HK-013 | CP-016 | production | Next linear agent designated by Cody | app/**, components/**, lib/editor/**, lib/capture/browser.ts, related UI/seek tests, docs/changes/HK-013.md | HK-012 verified local base | Bounded frame fix, mode rail/context toolbar, Generate and concise copy; light checks per section 6 | planned |
| HK-014 | CP-017 | production | Linear stability agent designated by Cody | Bounded repo-wide stability/security fixes; docs/changes/HK-014.md | HK-013 stable local base | Protect 08:00–10:00; one full verifier, targeted repairs and core journey | planned |

### Active checkpoints

### CP-018

```yaml
id: "CP-018"
objective: "Must-have Mesh/Splat Layers button: independent view toggles for either, both or none; hover highlight only if it fits the time box"
task_ids: ["HK-012"]
depends_on: ["CP-014"]
owner: "One linear agent on production"
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
status: "ready_for_review"
acceptance_gate: "Mesh/Splat toggles work independently without saving revisions; only hidden objects stay hidden; none shows a concise hint; PNG/video use the visible layers and GLB retains geometry semantics; typecheck/relevant tests and one short browser check pass. Hover is optional within the time box."
cut_fallback: "Keep the working dual toggles; defer hover embellishment. Never cut Layers to finish optional hover."
evidence_ref: "docs/changes/HK-012.md"
```

### CP-016

```yaml
id: "CP-016"
objective: "Simplify editor and project-wide UI: fixed left icon mode rail, right details, contextual bottom actions; compact playback/key popovers, Generate redesign and usable video frame selection"
task_ids: ["HK-013"]
depends_on: ["CP-014"]
owner: "One linear agent on production"
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
status: "ready_for_review"
acceptance_gate: "Independent runnable subpasses: A frame/seek fix, B mode rail and contextual toolbar, C Generate flow, D concise copy. Existing capture/generation/edit/save/export works after each commit. No permanent timeline, no dead/duplicate controls, HeroIcons and established style retained. Targeted checks and one quick browser smoke per subpass; full verification belongs to the stability gate."
cut_fallback: "Deliver the mode rail, context actions, frame selection and concise Generate flow; cut optional animation, hover or layout embellishments. Stop new features at 08:00."
evidence_ref: "docs/changes/HK-013.md"
```

### CP-017

```yaml
id: "CP-017"
objective: "Protected 08:00–10:00 stability, bounded security review and polish; preserve a working demo and rollback"
task_ids: ["HK-014"]
depends_on: ["CP-016"]
owner: "One linear stability agent on production"
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
status: "ready_for_review"
acceptance_gate: "Run one integrated npm run verify; review auth/ownership, private assets, server-only secrets, paid-job resubmission controls, and actual dependency findings. Fix demo blockers/high-risk defects with targeted rechecks; run one short core journey and verify saved outputs. Document remaining risks, fallback and exact revision; no publication without Cody."
cut_fallback: "Keep the known-good local build, fix only blocking/high-risk defects, and document lesser issues. Do not spend the reserved window adding features."
evidence_ref: "docs/changes/HK-014.md"
```

<details>
<summary>Historical, retained and deferred checkpoint records (not the current execution order)</summary>

CP-001..006 are old staging records, superseded by later continuation plans. Do not restart them. Completed work and approval/evidence references below are preserved; CP-019/020 readiness is updated from current evidence. CP-015 was absorbed by CP-020. CP-021/024/025 do not consume this window.

### CP-001

```yaml
id: "CP-001"
objective: "Create the fresh starter and resolve transport/reconstruction risk before UI expansion"
task_ids: ["HK-001", "HK-002"]
depends_on: []
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "STABLE-V0; record real provider and Chert capability evidence or explicit fallback"
cut_fallback: "Normal upload plus labeled imported fixture; do not claim unproven reconstruction or calls"
evidence_ref: null
```

### CP-002

```yaml
id: "CP-002"
objective: "Build one capture-to-edit journey with persistence"
task_ids: ["HK-003", "HK-004"]
depends_on: ["CP-001"]
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "Same ingestion schema across sources; mesh editing and authenticated reload"
cut_fallback: "One object, one source image, one demo account; no room-wide automation"
evidence_ref: null
```

### CP-003

```yaml
id: "CP-003"
objective: "Complete forks, outputs, and truthful live-integration proof"
task_ids: ["HK-005", "HK-006"]
depends_on: ["CP-002"]
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "STABLE-V1; STABLE-V2 only if both live reconstruction and Chert ingestion pass"
cut_fallback: "PNG and static GLB; disclose any fixture/manual geometry"
evidence_ref: null
```

### CP-004

```yaml
id: "CP-004"
objective: "Freeze, record, and submit the early version before the conservative cutoff"
task_ids: ["HK-007"]
depends_on: ["CP-003"]
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "RC-1; FINAL for the early version only after submission confirmation"
cut_fallback: "Keep tested footage and known-good local demo; remove unsupported track claims"
evidence_ref: null
```

### CP-005

```yaml
id: "CP-005"
objective: "Use confirmed extra build time for motion and at most one stretch feature"
task_ids: ["HK-008", "HK-009"]
depends_on: ["CP-004"]
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "Organizer-confirmed extended window; video/physics proof; optional stretch tested separately"
cut_fallback: "Defer HK-009 and preserve the early release; no additional code if the earlier cutoff stands"
evidence_ref: null
```

### CP-006

```yaml
id: "CP-006"
objective: "Verify the final permitted release, presentation, and submission"
task_ids: ["HK-010"]
depends_on: ["CP-005"]
owner: "Cody"
approval: "proposed"
approval_ref: null
status: "planned"
acceptance_gate: "FINAL on exact integrated revision with accessible artifacts and observed receipt"
cut_fallback: "Retain early submission if updates are not allowed or the later build regresses"
evidence_ref: null
```

### CP-007

```yaml
id: "CP-007"
objective: "Track A 1: persist the provider Gaussian splat as an S1 splat asset aligned with the normalized mesh, exposed as outcome.splatAsset"
task_ids: ["HK-011"]
depends_on: []
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "Runner tests with a synthetic PLY: valid splat stored (kind splat, under 50 MB, S1 space), output.splatAssetId set, outcome.splatAsset returned; missing or invalid PLY gives a mesh-only success with a warning; no paid call. A numeric S1 check on the recovered round-table PLY against its normalized mesh bounds is recorded. npm run verify passes."
cut_fallback: "Mesh-only jobs unchanged; record the transform blocker exactly"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-008

```yaml
id: "CP-008"
objective: "Track A 2: give the already-paid round-table job a stored S1 splat without a new fal request (S5)"
task_ids: ["HK-011"]
depends_on: ["CP-007"]
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "In private project prj_ba1f1945c81d48ac9aecf6bb01dc07fa the round-table job resolves to a splat asset that downloads from private storage after a restart and parses as S1; fal request count unchanged; npm run verify passes."
cut_fallback: "Track B uses a local S1 file for CP-014 with the gap recorded"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-009

```yaml
id: "CP-009"
objective: "Track A 3: decide how a 2–3 object request maps provider individual outputs to masks (S4 phase 2)"
task_ids: ["HK-011"]
depends_on: ["CP-008"]
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4 (paid call still needs separate approval)"
status: "complete"
acceptance_gate: "Either a proposal in HK-011 (API/contract delta, evidence of index-to-mask mapping and relative placement) or a recorded child-jobs-only decision; any live call approved by Cody beforehand and its spend reported; npm run verify passes."
cut_fallback: "Child jobs only (Track B CP-012 already ships them)"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-010

```yaml
id: "CP-010"
objective: "Track A 4 (deferrable): cached simplified-mesh derivative for interactive preview"
task_ids: ["HK-011"]
depends_on: ["CP-007"]
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "Derivative stored separately with the original kept and referenced; a visual comparison is recorded before any 100k default; no fal charge; npm run verify passes."
cut_fallback: "Defer; full-resolution mesh stays the only geometry"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-011

```yaml
id: "CP-011"
objective: "Track B 1: Spark-backed splat layer with a Mesh/Splat switch and mesh-only fallback (S3 attach)"
task_ids: ["HK-012"]
depends_on: []
owner: "Track B agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "Spark version and three 0.187 compatibility recorded; a browser renders a local PLY splat on an object, switches layers, falls back to mesh on a missing or invalid splat; S3 attach unit-tested; npm run verify passes."
cut_fallback: "Mesh-only view unchanged; record the renderer blocker after one bounded attempt"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-012

```yaml
id: "CP-012"
objective: "Track B 2: one object transform for both layers, and batch Generate as 2–3 child jobs (S4 phase 1)"
task_ids: ["HK-012"]
depends_on: ["CP-011"]
owner: "Track B agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "Translate/rotate/scale, undo, fork and save/reload keep the splat and mesh together with no double normalization; one Generate action tracks 2–3 durable child jobs with real per-job states; partial failure and retry never resubmit a job that has a request ID; npm run verify passes."
cut_fallback: "Single-object Generate stays; transforms remain mesh-only if splats are unavailable"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-013

```yaml
id: "CP-013"
objective: "Track B 3: persistent bottom timeline, context-aware right pane, PNG at the current playhead"
task_ids: ["HK-012"]
depends_on: ["CP-012"]
owner: "Track B agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "Play/pause, scrub and time display; PNG exports exactly the current playhead, view and layer with no separate frame selector; source time and take time remain distinct; scrubbing makes no provider calls; npm run verify passes."
cut_fallback: "Static take with existing PNG export"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-014

```yaml
id: "CP-014"
objective: "Track B 4: real data in the browser: round-table splat via attach_splat aligned with its mesh, and a real multi-object Generate laid out by levelled placements"
task_ids: ["HK-012"]
depends_on: ["CP-013", "CP-008", "CP-009"]
owner: "Track B agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "complete"
acceptance_gate: "On integrated production: attach_splat from the UI gives the round-table object its stored splat, aligned, switchable, moved with its mesh, saved and reloaded; the two existing live chair jobs in the round-table project (job_17892b91012a4fe3a285723eee3c0866, job_072267167d084939a825f393ef380b6e) or a seeded batch are added with levelled placements and look upright and plausibly spaced; screenshots recorded; no fal submit; npm run verify passes."
cut_fallback: "Show mesh with the splat alignment gap described; no fabricated splat claims"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-015

```yaml
id: "CP-015"
objective: "Track B 5 (deferrable): 5-second authored clip export from the evaluated scene"
task_ids: ["HK-012"]
depends_on: ["CP-013"]
owner: "Track B agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-14 23:40 — split PLAN v3 into Tracks A/B; PLAN v4"
status: "deferred"
acceptance_gate: "A 5 s clip matches the playhead-evaluated scene frame by frame at the take rate; no provider calls during export; npm run verify passes."
cut_fallback: "Defer; PNG at the playhead remains the export"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-025

```yaml
id: "CP-025"
objective: "Timeline editor and export screen: per-object tracks with clip ranges (absent outside the range) and keys on their track; an export screen with range, duration, frame rate, resolution and camera instead of a fixed 5 s clip"
task_ids: ["HK-012"]
depends_on: ["CP-019", "CP-020"]
owner: "Deferred beyond this working window"
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
status: "deferred"
acceptance_gate: "Each object shows as its own track; trimming or moving a clip changes when the object exists, and playback, PNG and video agree with it; keys edit on their track with undo, fork and save/reload; the export screen produces the chosen range, rate and resolution, and the output matches the playhead scene at sampled frames; a contract change (e.g. clip ranges on tracks) is proposed to Cody first if the take model lacks it; npm run verify passes."
cut_fallback: "Per-object visibility ranges only; export keeps the CP-019/CP-020 options"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-019

```yaml
id: "CP-019"
objective: "Unified export: one Export button and one modal (PNG at playhead, GLB, video when available, project .zip)"
task_ids: ["HK-012"]
depends_on: ["CP-013"]
owner: "Linear editor agent on production"
approval: "approved"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
status: "ready_for_review"
acceptance_gate: "Every existing export reachable from the modal with the same output as before; options shown only when implemented; progress via the shared overlay; npm run verify passes."
cut_fallback: "Separate buttons stay"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-020

```yaml
id: "CP-020"
objective: "Editable camera keys/spline with one active render camera and independent free navigation; real capture estimates only; user-defined duration (optionally initialized from ingest length) and video export (absorbs CP-015). Smooth key interpolation explicitly approved by Cody during CP-020."
task_ids: ["HK-012"]
depends_on: ["CP-013", "CP-019"]
owner: "Linear editor agent on production"
approval: "approved"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
status: "ready_for_review"
acceptance_gate: "Camera keys or spline points edit like object keys (undo, fork, save); free navigation is independent of the active render camera; playback and PNG/video use the camera path; duration is user-editable and can initialize from real source timing without fabricating motion; video exported in the tested browser's supported format matches the playhead scene and chosen duration; capture-seeded path only when real estimates exist (otherwise labelled authored); npm run verify passes."
cut_fallback: "Authored camera keys only; PNG at playhead"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-021

```yaml
id: "CP-021"
objective: "Agentic inference for playback: design spike, then a bounded build where a model proposes object motion or a camera path that the person reviews"
task_ids: ["HK-012", "HK-011"]
depends_on: ["CP-020"]
owner: "Deferred; design approval still required before any build"
approval: "proposed"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a): brainstorm needed before building"
status: "deferred"
acceptance_gate: "Design note with options, cost per proposal and the review UI, approved by Cody; then a proposal becomes editable keys, never auto-applied; real model response recorded."
cut_fallback: "Manual keys and camera spline only"
evidence_ref: "docs/changes/HK-012.md"
```

### CP-022

```yaml
id: "CP-022"
objective: "Live-call loop: dedupe frames, segment the best fresh keyframe while ingesting, start at most one reconstruction before hang-up (session-level continuous, ADR-004)"
task_ids: ["HK-011"]
depends_on: ["CP-009"]
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
status: "ready_for_review"
acceptance_gate: "Real call: near-duplicate frames dropped (count recorded); a segmentation job runs during the call on a frame received in it; a newer frame supersedes only with better coverage; no job resubmitted; spend reported and within budget; tests for the selector; npm run verify passes."
cut_fallback: "Ingest during the call, generate after hang-up (today's behaviour)"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-023

```yaml
id: "CP-023"
objective: "Return video to the caller: latest captured frame with recognised-object boxes coloured red to green by coverage (activates F-012)"
task_ids: ["HK-011"]
depends_on: ["CP-022"]
owner: "Track A agent"
approval: "approved"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
status: "ready_for_review"
acceptance_gate: "On a real call the caller sees the agent's video track change as frames and boxes update; no echo loop or growing queue; works within the ~35 s call; recorded evidence."
cut_fallback: "Static status card as the agent's video"
evidence_ref: "docs/changes/HK-011.md"
```

### CP-024

```yaml
id: "CP-024"
objective: "ElevenLabs spoken capture coaching on the FaceTime call (move slower or faster, keep the object in view, capture more of the scene)"
task_ids: ["HK-011"]
depends_on: ["CP-022"]
owner: "Deferred beyond this working window"
approval: "approved"
approval_ref: "Cody chat 2026-11-15: compact remaining work until 10:00 A.M.; final two hours stability/polish; sequential agents; light feature checks; Layers and simplified UI/Generate/frame picking required; confirmed left mode rail/right details."
status: "deferred"
acceptance_gate: "Guidance derived from real metrics (frame-to-frame motion, coverage, object in frame); spoken through ElevenLabs TTS on the agent audio track; rate-limited so prompts do not overlap; free credits only; how it is used recorded for the Devpost section; npm run verify passes."
cut_fallback: "Text guidance only (status card)"
evidence_ref: "docs/changes/HK-011.md"
```

</details>

## 6. Technical verification and deployment

```yaml
runtime_version: "Node.js 22.18.0"
package_manager: "npm"
install: "npm ci (only when setup is needed and the root dev server is stopped)"
unit_tests: "npm test -- --project unit <relevant test files>"
typecheck: "npm run typecheck"
lint: "npx eslint <changed files>"
build: "npm run build"
integration_e2e: null
run_demo: "npm run dev -- -p 3005"
external_services: ["TigerData", "Supabase Auth and Storage", "fal", "Chert", "LiveKit"]
secrets_location: "Ignored .env.local; never print, commit or expose server keys"
test_environment: "Local browser, existing dedicated test projects/assets and existing durable jobs"
```

- **Feature increments:** relevant type/logic checks plus one short browser smoke; target roughly 5 minutes of validation. Cosmetic/copy-only changes need a compile/visual check, not new mirror tests. Record actual commands, revision and limits. Stop checking after the bounded gate passes unless a new failure/change warrants it.
- **08:00 stability gate:** run npm run verify once on the integrated feature revision. It includes the existing live-platform suite. Recheck actual fixes with targeted tests; repeat the full gate only for substantive changes or a remaining required failure, not every polish commit.
- **No repeated paid proofs:** frame-picker and Generate UI checks use a small owned clip, existing finished jobs or the reference backend. Any new fal spend needs Cody's explicit estimate/approval and actual-spend report. Give him notice before any real FaceTime call.
- Run Node tools from uppercase C:. Keep native skill adapters intact. After a deliberately approved contract edit, regenerate JSON schemas. No contract change is expected for the remaining UI work.
- Current full evidence: HK-012, clean `f317b7f0d2f8`, 329 tests plus all gates. A stale dev validator needed restarting to accept the approved interpolation option. The app is on :3005; Cody authorized stopping stray servers if necessary.

## 7. Known risks, unknowns and cuts

| Risk | Trigger | Bounded response / cut |
| --- | --- | --- |
| Frame cannot be changed | Generate disables frame selection/refresh for any saved batch; reset is below the results | Make a new-frame action obvious; preserve durable jobs and never resubmit automatically |
| Video picker appears stuck | seekVideo waits unconditionally for seeked, including same-position/repeated seeks; no error/timeout | Reproduce with two timestamps, fix only the narrow browser seek/UI state path if needed |
| UI rewiring breaks a working action | Old entry removed before new handler works | Move existing handlers intact; each commit runs independently; revert only the bad increment |
| Scope consumes the final buffer | A time box is exhausted or clock reaches 08:00 | Cut optional hover/animation extras; no full object timeline, coaching or agentic feature work |
| Video performance / browser codecs | Unsupported encoder, slow splats, or buffer guard | Offer supported local output; existing PNG/GLB remain fallback; cross-device/mobile playback not yet proven |
| Security or demo blocker | Ownership, keys, repeated spend, save/export failure | Fix during protected stability window; disclose smaller accepted risks |
| Unverified event/submission details | Exact official deadline or track clause unknown | Cody verifies separately; no invented certification, eligibility or submission receipt |

## 8. Demo, video and submission

Preserve the short, honest journey: existing real capture → select frame → reuse a generated object → toggle mesh/splat → edit/fork/save → camera playback → PNG/GLB/video. Prepared assets and prior call recordings are disclosed. Dimensions and hidden surfaces remain estimates. Do not wait for a new paid reconstruction during the UI smoke.

At 08:45–09:30 rehearse the working build, retain representative exports and a known-good fallback. Cody owns narration/video/submission; the final half-hour is buffer, not another feature slot. Repository access, deployment and actual submission must be checked separately if requested. Nothing here claims submission, remote publication or a new stable tag.

## 9. Approved updates and gate log

| Plan version | Date | Release | Accepted task IDs / ADR IDs | Updated by | Approval/evidence | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1–6 | Historical | STABLE-V2 local | Existing tasks and ADR-001..005 | Prior agents for Cody | Archived v6 and docs/DECISIONS.md | Full historical intent/evidence retained |
| 7 | 2026-11-15 | No new release | HK-012 / HK-013 / HK-014; CP-018 / CP-016 / CP-017 | Codex for Cody | Cody's explicit five-hour replan, light checks, sequential agents and confirmed left-rail/right-details layout; CP-020 passes at f317b7f0d2f8 | Finish realistic must-haves before 08:00; protect 08:00–10:00 for stability/polish |
| 7 | 2026-11-15 | STABLE-V3 local (c88214d) | CP-018 / CP-016 A–E / CP-019 / CP-020 / CP-017 | Claude for Cody | Cody asked for cleanup and /create-stable; `npm run verify` passes on clean c88214d in a detached worktree (338 tests, live platform included). Unfinished CP-025 parked on `wip/CP-025-clips` (db6a2b5) | Stable point after the stability window; rollback STABLE-V2 |
| 8 | 2026-11-15 | STABLE-V3.1 local (964d0cc) | CP-026..CP-028 planned; CP-029..CP-031 proposed (paid, need approval) | Claude for Cody | Cody's UI nits and behavioural ideas, 2026-11-15 ~07:55 | Final polish plus one bounded experiment before 10:00 |

**Next agent:** CP-018 (HK-012) and CP-016 A to D (HK-013) are `ready_for_review`. CP-017 (HK-014) is `ready_for_review`: the full verifier passes at `0cfd49e` (338 tests), the security review is done with two fixes, the journey rehearsal and one approved live Generate pass, and Generate can reuse a frame's earlier results (HK-013 subpass E, approved by Cody). Read AGENTS.md, this v7 continuation and docs/changes/HK-014.md "Remaining for the window". Open with Cody: his look at the layout. No new features after 08:00.

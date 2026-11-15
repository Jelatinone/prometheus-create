# Architectural decisions

Canonical accepted decisions only. Proposed deviations stay in task notes. Preserve history and append superseding decisions; do not silently rewrite an earlier decision. Start with an empty index and add an allocated ADR record only after approval.

## Decision index

| Decision ID | Date | Status | Title | Origin task | Plan version |
| --- | --- | --- | --- | --- | --- |
| ADR-001 | 2026-11-14 | accepted | Product name: Prometheus::create | HK-001 | 2 |
| ADR-002 | 2026-11-14 | accepted | Visual identity: warm white, charcoal, vermilion; project logo | HK-001 | 2 |
| ADR-003 | 2026-11-15 | accepted | Sponsor targets: Chert, General, FaZe, Tiger Data; ElevenLabs secondary | HK-012 | 6 |
| ADR-004 | 2026-11-15 | accepted | Live-call generation is session-level continuous; provider jobs stay single-shot | HK-012 | 6 |
| ADR-005 | 2026-11-15 | accepted | Layer visibility is a view setting (Mesh/Splat toggles); hover highlight via the mesh layer | HK-012 | 6 |

## Accepted records

### ADR-001

```yaml
id: "ADR-001"
date: "2026-11-14"
status: "accepted"
approver: "Cody"
approval_ref: "2026-11-14 chat instruction during HK-001: \"Name: Prometheus::create\""
origin_task: "HK-001"
plan_version: 2
supersedes: null
```

#### Context

PLAN v1 decision D-001 named the product Daedalus (former working name Rift). The repository was later created as `prometheus-create`, and HK-001 proposed reconciling the two (task note deviation HK-001-D6).

#### Decision

The product name is **Prometheus::create**. It is defined once in `lib/brand.ts` (`PRODUCT_NAME`) and used for the page title and header. Interface labels such as Project, Source, Take, and Export stay unchanged.

#### Reasoning

Cody's explicit choice; one constant keeps any later rename to a single edit. Keeping Daedalus would leave the repository, UI, and plan disagreeing.

#### Affected consumers and migrations

PLAN.md title, header metadata, D-001, demo script, and track wording; the app header and page title. No data or contract migration.

#### Verification and gate

`npm run verify` passes on the revision that applies it; the header renders the name.

#### Consequences and rollback

Submission, video, and README use Prometheus::create. Rollback: change `PRODUCT_NAME` and PLAN back.

#### Source

HK-001 (`docs/changes/HK-001.md`), branch `feat/HK-001-foundation`.

### ADR-002

```yaml
id: "ADR-002"
date: "2026-11-14"
status: "accepted"
approver: "Cody"
approval_ref: "2026-11-14 chat instruction during HK-001: colors bg #F3F0E9, hover accent #FF6842, text #17191D; logo in /public"
origin_task: "HK-001"
plan_version: 2
supersedes: null
```

#### Context

PLAN v1 §1 proposed "a neutral dark interface and one accent color". Cody chose a light palette and supplied a project logo.

#### Decision

Primary colors: background warm white `#F3F0E9`, primary text charcoal `#17191D`, accent vermilion `#FF6842` for text on hover. They are theme tokens in `app/globals.css` (`canvas`, `ink`, `accent`; Tailwind classes `bg-canvas`, `text-ink`, `hover:text-accent`), with derived supporting tokens (`muted`, `panel`, `panel-2`, `line`, `ok`, `bad`). The logo is `public/prometheus-logo.png` (1254 × 1254 PNG), shown in the header via `next/image`.

#### Reasoning

Cody's explicit choice. Tokens give every lane one source for color, so components never hard-code hex values.

#### Affected consumers and migrations

All UI lanes (editor shell, capture panel, platform pages) use the tokens. PLAN §1's dark-interface sentence now points here.

#### Verification and gate

Measured contrast on `#F3F0E9`: charcoal 15.5:1 and `muted` 5.4:1 (pass WCAG AA); vermilion about 2.5:1, below AA for text.

#### Consequences and rollback

Vermilion is reserved for hover/focus states and large accents, paired with an underline or weight change, never as the only cue or for body text. Selection, warning, and provenance still need text or icon cues (PLAN §1). The 3D viewport background is the editor lane's choice within this palette. Rollback: revert the token values in `app/globals.css`.

#### Source

HK-001 (`docs/changes/HK-001.md`), branch `feat/HK-001-foundation`.

## Integration procedure

1. Read the proposed deviation and affected consumers.
2. Explicitly accept/reject/defer; allocate an ADR only for acceptance.
3. Synchronize PLAN, plan version, approval reference, and the decision before dependent implementation.
4. Record integrated verification and merge SHA once available; do not claim future evidence.

### ADR-003

```yaml
id: "ADR-003"
date: "2026-11-15"
status: "accepted"
approver: "Cody"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
origin_task: "HK-012"
plan_version: 6
supersedes: null
```

**Sponsor targets for the remaining work**

#### Context
PLAN §2 limited active targets to three and deferred ElevenLabs and FaZe. With the core product working, Cody re-prioritised the event tracks.

#### Decision
Primary: Chert (Best Use of FaceTime), the General track, the FaZe Clan Challenge (gated on reading its full requirements) and Best Use of Tiger Data. Secondary: ElevenLabs, through spoken capture coaching on the call. Opportunistic: Gemini (only through CP-021), the DEV writing challenge, GoDaddy or Vultr (only if a real deployment needs them). Not pursued: Solana, MongoDB Atlas, hardware, SpaceXSI.

#### Reasoning
Each primary target is either already real (Tiger Data, the general product) or extends the existing FaceTime ingestion (Chert). ElevenLabs adds a visible, low-cost feature on that same call. The rest would need new architecture or claims we cannot back.

#### Affected consumers and migrations
PLAN §2 v6 target set, §8 submission write-up sections ("How We Used ElevenLabs", Tiger Data usage). No code migration.

#### Verification and gate
Each claimed track has recorded evidence in a task note before submission; FaZe requirements are quoted in PLAN before any FaZe-specific work.

#### Consequences and rollback
If a target slips, drop its claim rather than ship an unproven integration. Reverting this ADR restores the v5 targeting.

### ADR-004

```yaml
id: "ADR-004"
date: "2026-11-15"
status: "accepted"
approver: "Cody"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
origin_task: "HK-012"
plan_version: 6
supersedes: null
```

**Live-call generation is session-level continuous**

#### Context
Cody asked whether generation can run while the FaceTime call is still ingesting, ideally as a "continuous" job that accepts new frames, without major architectural change. SAM 3D jobs take one image and mask and return one result; calls last about 35 seconds.

#### Decision
Provider jobs stay single-shot and durable (no streaming job, no contract change). The capture agent keeps ingesting; a selector drops near-duplicate frames and keeps the best fresh keyframe; segmentation runs on it during the call; at most one reconstruction is started before hang-up; a newer frame replaces the pending choice only when coverage improves. Results reach the editor through the existing job and ingestion paths.

#### Reasoning
It delivers the visible "working while you film" behaviour with the existing runner, route, locks and never-pay-twice rules, inside the call length and budget.

#### Affected consumers and migrations
services/capture-agent (selector, job trigger, return video), the reconstruction route (unchanged API). Track A owns it (CP-022 to CP-024).

#### Verification and gate
CP-022 acceptance gate: real call evidence, dedupe counts, no resubmission, spend recorded.

#### Consequences and rollback
If the in-call job is too slow, fall back to generating after hang-up (current behaviour). A true streaming job would need a new ADR and contract proposal.

### ADR-005

```yaml
id: "ADR-005"
date: "2026-11-15"
status: "accepted"
approver: "Cody"
approval_ref: "Cody chat 2026-11-15 (plan revision before merging Track B into track-a)"
origin_task: "HK-012"
plan_version: 6
supersedes: null
```

**Layer visibility is a view setting; hover highlight works over splats**

#### Context
Each object has a persisted Mesh/Splat switch (`SceneObject.splat.enabled`). Cody wants a top-toolbar Layers pop-up that toggles Mesh and Splat independently (both, either or none), and an accent hover highlight that still works while only the splat is visible.

#### Decision
The Layers pop-up controls two view toggles that are not saved with the take. An object draws its mesh when Mesh is on, and its splat when Splat is on and it has a valid splat whose `enabled` is true (on attach it is true). Both or neither may be shown. Hover picks against the mesh layer even when it is hidden and highlights that object in the accent colour.

#### Reasoning
Viewing choices should not create revisions. Keeping `splat.enabled` preserves the contract and lets an object opt out of the splat layer.

#### Affected consumers and migrations
lib/scene/viewport.ts (layer filters, hover), components/editor (Layers pop-up, inspector simplification). No contract change.

#### Verification and gate
CP-018 acceptance gate.

#### Consequences and rollback
If confusing, revert to the per-object switch only.

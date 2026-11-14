# Architectural decisions

Canonical accepted decisions only. Proposed deviations stay in task notes. Preserve history and append superseding decisions; do not silently rewrite an earlier decision. Start with an empty index and add an allocated ADR record only after approval.

## Decision index

| Decision ID | Date | Status | Title | Origin task | Plan version |
| --- | --- | --- | --- | --- | --- |
| ADR-001 | 2026-11-14 | accepted | Product name: Prometheus::create | HK-001 | 2 |
| ADR-002 | 2026-11-14 | accepted | Visual identity: warm white, charcoal, vermilion; project logo | HK-001 | 2 |

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

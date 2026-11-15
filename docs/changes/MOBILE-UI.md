# Mobile UI compatibility

```yaml
schema_version: 2
id: "MOBILE-UI"
checkpoint_id: "CP-016"
status: "ready_for_review"
branch: "codex/mobile-ui"
base_ref: "f8d0ebf"
owner: "Codex for Cody"
created_at: "2026-11-15"
updated_at: "2026-11-15"
plan_version_at_start: 8
feature_ids: []
contract_ids: []
depends_on: []
owned_paths: ["components/**", "app/globals.css", "app/layout.tsx", "lib/scene/viewport.ts", "docs/changes/MOBILE-UI.md"]
```

## 1. Outcome and acceptance

Make existing editor, saves, capture and export controls usable on phone and tablet widths without changing saved data, backend or paid jobs. Current user instruction explicitly authorizes this separate worktree and bounded 45-minute compatibility pass, overriding earlier production-only and freeze instructions for this task. MOBILE-UI is a descriptive handoff identifier, not a new centrally allocated HK number. No edits to the main checkout.

## 2. Implementation plan

### Objective

Keep the scene visible and all existing tools reachable by touch at 320–430 px portrait, phone landscape, tablet and desktop widths.

### Scope and exclusions

Responsive chrome, collapsible phone details, scrollable action rows, safe-area spacing, touch targets, playback, capture, export and saves overflow. No contracts, providers, dependencies or backend changes. Desktop arrangement preserved.

### Inputs and baseline

User assignment; PLAN v8 and CP-016/HK-013 evidence; f8d0ebf production base; isolated codex/mobile-ui worktree. Existing phone header widths collide, details permanently obscure the scene, and bottom actions wrap without a bounded height.

### Ordered steps

| Step | Outcome | Task IDs | Owned paths | Dependencies | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | Responsive editor with dismissible details and reachable tool rows | MOBILE-UI | components/editor, app/globals.css | Existing actions | Width and interaction smoke |
| 2 | Touch/safe-area and overflow fixes on capture, saves, playback and dialogs | MOBILE-UI | components, app/layout.tsx, app/globals.css | Step 1 | Phone/tablet/desktop smoke |
| 3 | Light checks and reviewable handoff | MOBILE-UI | task note | Steps 1–2 | Typecheck, changed-file lint, targeted editor tests |

### Acceptance and verification

No horizontal page overflow at 320, 390, 768 and desktop widths. Mode, details close/reopen, Layers, capture, playback, export and save actions stay reachable. Touch viewport navigation stays functional. Record actual checks and distinguish emulation from real hardware; no paid provider calls or full repeated verifier.

### Risks and rollback

Keep existing handlers and data flow. CSS scoped to editor/saves/mobile breakpoints. Inspect desktop after mobile changes. Roll back only this branch's compatibility commits; no merge, deploy or tags.

### Decisions requiring approval

None for assigned compatibility scope. User explicitly requested separate worktree; do not integrate into production automatically.

## 3. Actual changes and evidence

**Delivered:** responsive editor identity/actions rows; phone details hidden until a mode is selected, dismissible and independently scrollable; bounded contextual action and view rows; compact landscape rail; reachable Layers above playback; touch account menu with outside-tap/Escape dismissal; project rename reachable on phones; compact playback scrubber; responsive saves/search/list/details/example menu; scrollable short-screen dialogs; safe-area viewport and spacing; 44 px touch targets and 16 px compact-layout inputs without disabling browser zoom. Existing scene handlers, camera semantics, saved data and backend remain unchanged. Desktop layout visually inspected at 1440 x 900.

| Check | Revision/artifact | Environment | Expected | Observed | Status |
| --- | --- | --- | --- | --- | --- |
| Worktree setup | f8d0ebfebd431767793207edd519f5485bb4d229 | `npm run lane:setup` | Isolated pinned toolkit/dependencies | Submodule initialized; skill checks and npm ci passed; no dependency file edits | pass |
| Types | working tree based on f8d0ebf | `npm run typecheck` | Next route types and TS clean | Exit 0; initial bare tsc before Next generation lacked the image declaration, resolved with normal typecheck | pass |
| Lint | same working tree | eslint on changed TSX files | Clean | Exit 0; UsageWarning checked separately after its height-only edit | pass |
| Camera/playback regressions | same working tree | `npx vitest run tests/editor/timeline.test.ts tests/editor/camera.test.ts` | Existing behavior preserved | 12 passed in 2 files | pass |
| Editor touch/layout | `.verify/mobile-smoke.mts`, `.verify/mobile-smoke.json` (ignored local artifacts) | Chrome, worktree server :3015, existing axis-box fixture; 320x740, 390x844, 768x1024, 844x390, 1024x768, 1440x900 | Header/rail/toolbar/details fit; modes, close/reopen, capture, playback, both Layers toggles, account and export reachable | All six sizes pass; zero page errors or provider submits | pass |
| Actual saves and viewport gesture | `.verify/mobile-extra.mts`, `.verify/mobile-extra.json` | Same browser; saves at 320/390/768/1024/1440 px | Actual saves visible, example menus within viewport, touch Open and free orbit work | All pass; drag changes render while Save remains disabled | pass |
| Visual inspection | `.verify/mobile-camera.png`, `mobile-export.png`, `mobile-editor-844.png`, `mobile-editor-1440.png`, `mobile-saves.png` | Screenshots viewed during implementation | No control collisions | Phone details/export/saves, short landscape, desktop inspected | pass |
| Patch hygiene | final patch | `git diff --check` | No whitespace errors | Exit 0 | pass |
| Full verifier | not run | n/a | Reserved for integrated stability gate | Intentionally omitted per user request for light checks | not_run |

**Findings resolved:** desktop centering translated the phone toolbar offscreen; Layers initially sat behind playback; short landscape put the Source icon behind the bottom toolbar; the narrow saves example menu needed a left offset. These are corrected in this patch. The development-only Next badge intercepted bottom-left taps; smoke scripts hide `nextjs-portal` in the test page only. No production configuration changed.

**Limits:** Chrome touch emulation, not physical iOS/Android hardware. Native camera permissions, on-screen keyboard behavior and physical safe-area insets need a device check. Existing video codec/device support is unchanged. No paid generation, upload, export encoding or save mutations were needed for this presentation pass. The first smoke's saves screenshots raced a device-emulation reload; the separate extra script explicitly waited for the actual active saves screen and verified its menus/Open. The tiny UsageWarning height-only change was linted, not shown in the authenticated walkthrough. Local screenshots/scripts are ignored and remain in this worktree.

## 4. Proposed deviations

No backend or contract changes. Separate-worktree exception explicitly authorized by the current user request.

## 5. Handoff and merge gate

Reviewer/integration owner: Cody. Review and merge pending. Base: `f8d0ebfebd431767793207edd519f5485bb4d229`; branch: `codex/mobile-ui`; worktree: `C:\Users\CodyW\.codex\worktrees\mobile-ui\prometheus-create`. Preview runs on port 3015; original main server untouched. No merge, push, tag or deployment. Main checkout source files were not edited.

Integration: apply this branch's mobile compatibility commit to the desired production revision, resolve any overlapping Editor/layout changes deliberately, and run the integrated gate there. Remaining device smoke: open details and keyboard on iPhone/Android, drag/pinch, rotate, then check native photo selection. Rollback: revert only the mobile UI commit; no data migration.

```yaml
reviewer: null
review_status: "pending"
approval_ref: null
integration_commit: null
merged_at: null
stable_release_including_change: null
rollback: "Revert the mobile UI compatibility commit; no saved data changes."
```

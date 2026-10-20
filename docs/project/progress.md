# Forge Development Progress

```
Project:            Forge — AI Engineering Control Plane
Current milestone:  Milestone M6 Generic Workflow Graph (Phase 5 in progress)
Overall status:     Generic Workflow Graph Engine (WORK-001..005, Phase 5 Slices 5B-1A/B/C-A) merged on main; Slice 5B-1C Slice B in open PR #228; production execution remains WorkflowService → Orchestrator pending cutover and 31-scenario parity verification.
Last updated:       2026-10-20
Evidence baseline:  main @ 07d3c4b (PR #227 merged) | Open PR: #228 (feat/m6-phase5-batch3-slice5b1c-reviewer-routing @ bdd6aa2)
Active branch:      feat/m6-phase5-batch3-slice5b1c-reviewer-routing (PR #228)
```

---

## 1. Progress Line

```
M0  Foundation & Quality Gates    ██████████  DONE        PR #186 merged
        ↓
M1  Headless Core                 ██████████  DONE        PR #198 merged (CORE-001/002)
        ↓
M2  Native Agent Core             ██████████  DONE        PR #198 merged (AGENT-001)
        ↓
M3  Forge CLI 1.0                 ███████░░░  IN PROGRESS PR #198 (CLI-001..3); CLI-004 not started
        ↓
M4  State, Events & Persistence   ██████████  DONE        PR #203 merged (STATE-001)
        ↓
M5  Verification & Criteria       ██████████  DONE        PR #208 merged (VERIFY-003)
        ↓
M6  Generic Workflow Graph        ████████░░  IN PROGRESS PRs #214-#227 merged (WORK-001..005, Slices 5B-1A/B/C-A); PR #228 in review; cutover pending
        ↓
M7  Human Control & Steering      ░░░░░░░░░░  NOT STARTED PTY spawner exists; UI wiring pending
        ↓
M8  Extensible Provider Ecosystem ░░░░░░░░░░  NOT STARTED 3rd-party adapters prototyped
        ↓
M9  Production Polish & Scale     ░░░░░░░░░░  NOT STARTED
```

---

## 2. Milestone Status Summary

| Milestone | Status | Completed Work | In Progress Work | Next Up |
| :--- | :--- | :--- | :--- | :--- |
| **M0 Baseline** | **DONE** | CI matrix, vitest suites, lint/formatting, baseline smoke check, Windows git EBUSY flakiness resolution (M0-002), spike #64 formal closure (M0-003). | — | — |
| **M1 Headless Core** | **DONE** | `createForgeCore` decoupled from Electron; `--data-dir` support. | — | Headless config loader (`.forgerc`). |
| **M2 Native Agent** | **DONE** | Native in-process tool loop (`taskRunner.ts`, `agentLoop.ts`), six tools in `providers/tools.ts`, streaming artifact ingestion (`AGENT-002`). | — | Eager concurrent tool execution (`AGENT-003`). |
| **M3 Forge CLI** | **IN PROGRESS** | Standalone `bin/forge.ts`, NDJSON stream, exit codes 0/1/2. | — no TUI work is in flight; see Q-IL-01. | Terminal TUI (`CLI-004`) not started. |
| **M4 State & Storage** | **DONE** | SQLite `RunStore`, `EventStore`, `ArtifactStore`, `ArtifactService` including `readWindow()` (PR #203). | — | Typed IPC event streaming. |
| **M5 Verification** | **DONE** | Physical diff reconciliation, `ChangeSet` snapshotting, completion-criteria evaluation & task loop integration, independent build/test runner (`verifier.ts`), untracked/binary reconciliation, adversarial evidence auditing (`VERIFY-003`, PR #208). | — | — |
| **M6 Workflow Graph** | **IN PROGRESS** | Generic Workflow Graph engine foundation: DAG execution (`WORK-001`, PRs #215–#216), stage controls (`WORK-002`, PR #217), conditional routing, bounded loops, and durable artifact lineage hydration (`WORK-003`, PRs #218–#221), M6 Phase 5 Batch 1 lifecycle stabilization & read models (`WORK-004`, PRs #222–#223), Batch 2 generic leaf runner (`WORK-005`, PR #224), Batch 3 Slice 5B-1A graph factory (PR #225), Batch 3 Slice 5B-1B binding resolution & role preflight (PR #226), Batch 3 Slice 5B-1C Slice A gate authorization (PR #227). | M6 Phase 5 Batch 3 Slice 5B-1C Slice B: authoritative reviewer routing and crash recovery (PR #228 open, head `bdd6aa2`, CI green, 43 unit tests). | Merge PR #228; execute WorkflowService production cutover and 31-scenario orchestrator parity verification (`WORK-006`). |
| **M7 Human Control** | **NOT STARTED** | ConPTY terminal session spawner validated in spikes. | — | Attach UI pane to running session. |
| **M8 Provider Ecosystem** | **NOT STARTED** | Claude/Antigravity adapters prototyped. | — | Data-driven provider config. |
| **M9 Polish & Scale** | **NOT STARTED** | — | — | Enterprise workspace management. |

---

## 3. Major Slice History & Merged PRs (Reverse Chronological)

### 2026-10-20: PR #228 (Slice 5B-1C Slice B) — IN REVIEW / OPEN
- **Title:** `feat(workflows): implement authoritative reviewer routing and crash recovery (Slice 5B-1C Slice B)`
- **Branch:** `feat/m6-phase5-batch3-slice5b1c-reviewer-routing` (HEAD `bdd6aa21c76d5747cd7f6bafc0bcd6dc447a395f`)
- **Status:** OPEN (unmerged)
- **Delivered:** Authoritative reviewer routing and crash-recovery verification:
  - Hardened `assessReview` runtime validation and fail-closed verdict (`unknown`, `overridden: true`) on empty or malformed criteria.
  - Exported and enforced `reviewOutcomeSchema` and `authoritativeReviewVerdictSchema` requiring explicit `changeSetId`, `evidenceId`, `stepId`, `iteration`, `verdict`, `overridden`, `reason`, and `rejectingFindings`.
  - Compiled conditional feedback edge on canonical linear templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`).
  - Implemented trusted reviewer execution in `LeafRunner` with authoritative verification evidence binding and genuine completed reviewer attempt identity.
  - Hardened recovery pending-feedback path in `GraphExecutor`: conditional evaluation of feedback edges, mandatory positive integer verification iteration metadata strictly matching `currentIteration`, changeset identity cross-validation, and idempotent replay of committed transitions.
  - Expanded `artifactKindSchema` and `artifactKindViewSchema` with compiled linear stage outputs (`stage_deliverable`).
- **CI & Tests:** CI Run [39438649157](https://github.com/mdsaif45/forge-orchestrator/actions/runs/39438649157) PASSED all 3 jobs (`App checks (Electron)`, `Format, lint, types, tests`, `App checks (Windows)`). 43 passing unit tests in `src/main/workflows/reviewerRouting.test.ts`.

### 2026-10-20: PR #227 (Slice 5B-1C Slice A) merged (`07d3c4b`)
- **Title:** `feat(workflows): implement gate-scoped human decision authorization (Slice 5B-1C Slice A)`
- **Delivered:** Gate-scoped human decision authorization in `GraphExecutor`:
  - Verified human gate authorization scoped strictly to current graph run and active node attempt.
  - Independent graph run project identity validation preventing cross-project approval leaks.
  - Fail-closed gate decision lookup and template resolution across full relationship chains.
  - Enforcement of read-only permission ceilings during gate execution.
- **CI & Tests:** CI Run [39358018332](https://github.com/mdsaif45/forge-orchestrator/actions/runs/39358018332) PASSED; 1,667 unit tests passing locally across 115 test files (3 skipped).

### 2026-10-19: PR #226 (Slice 5B-1B) merged (`57cc1a2`)
- **Title:** `feat(workflows): implement binding role resolution and capability preflight (Slice 5B-1B)`
- **Delivered:** Role resolution and capability preflight in `roleResolution.ts` and `leafRunner.ts`:
  - Enforced role permission ceilings (`read_only`, `workspace_write`, `unrestricted`) across stores, resolution, and execution.
  - Closed authorization bypasses for explicit `providerId` and default runtime.
  - Hardened read-only worktree enforcement across session disposal errors and all exit paths.
- **Tests:** 14 tests in `roleResolution.test.ts`.

### 2026-10-18: PR #225 (Slice 5B-1A) merged (`ba77460`)
- **Title:** `feat(workflows): add production graph composition factory (M6 Slice 5B-1A)`
- **Delivered:** `ProductionGraphFactory` (`src/main/workflows/graphFactory.ts`) for deterministic production graph executor construction, wiring SQLite stores, `ArtifactService`, `WorktreeService`, `LeafRunner`, and policy checks.
- **Tests:** 11 tests in `graphFactory.test.ts`.

### 2026-10-18: PR #224 (WORK-005) merged (`a1964a1`)
- **Title:** `feat(workflows): implement generic leaf runner for graph execution (WORK-005)`
- **Delivered:** Single-responsibility leaf runner (`src/main/workflows/leafRunner.ts`) coordinating discrete primitives (`exchange`, `buildChangeSet`, `verifyStep`, `compileContext`) with fail-closed change-scope enforcement and verification evidence mapping.
- **Tests:** 15 tests in `leafRunner.test.ts`.

### 2026-10-17: PR #223 merged (`e434c1e`)
- **Title:** `test(workflows): cover multi-iteration pause recovery`
- **Delivered:** Comprehensive test coverage for multi-iteration pause/recovery lifecycles in `src/main/workflows/graphLifecycle.test.ts`.

### 2026-10-17: PR #222 (WORK-004) merged (`bcecb65`)
- **Title:** `fix(workflows): M6 Phase 5 Batch 1 — Foundation Stabilization & Read Models`
- **Delivered:** Graph pause/recovery lifecycle stabilization and Slice 5A-1 graph read-model contracts (`src/shared/views/`):
  - Validated current pause evidence during recovery.
  - Fail-closed on pre-attempt and inter-node process crashes.
  - Graph read-model projections (`WorkflowDetailView`, `WorkflowNodeView`, `WorkflowEdgeView`).
- **Tests:** 28 lifecycle tests in `graphLifecycle.test.ts`, 25 read-model tests in `views.test.ts`.

### 2026-10-15: PR #221 (WORK-003 Slice 2C-1) merged (`6f7df99`)
- **Title:** `feat(workflows): implement durable artifact lineage hydration on crash recovery (WORK-003 Slice 2C-1)`
- **Delivered:** Durable artifact lineage hydration during `GraphExecutor` crash recovery, fail-closed handling of ambiguous target slots, output substitution prevention, and separation of required artifact completeness from persistence durability.
- **Tests:** 42 lineage recovery scenario tests in `graphExecutor.test.ts`.

### 2026-10-13: PR #220 (WORK-003 Slice 2B) merged (`4a9e594`)
- **Title:** `feat(workflow): implement WORK-003 Slice 2B feedback loops, iteration advancement, and worktree patching`
- **Delivered:** Feedback loop iteration advancement, loop fingerprint tracking (`loopFingerprint.ts`), bounded iterations (Axiom A5), and worktree patch transfer across iterations.

### 2026-10-05: PR #219 (WORK-003 Slice 2A) merged (`0144cbe`)
- **Title:** `feat(workflow): WORK-003 Slice 2A — router nodes, conditions, and branch pruning`
- **Delivered:** Conditional branch evaluation, router nodes, dynamic branch pruning, and dead-path elimination in `GraphExecutor`.

### 2026-10-04: PR #218 (WORK-003 Slice 1) merged (`cc3da3d`)
- **Title:** `feat(workflow): WORK-003 Slice 1 — loop persistence and transition invariants`
- **Delivered:** SQLite schema support for loop iterations, durable iteration counters, and state transition invariants.

### 2026-10-01: PR #217 (WORK-002) merged (`8a5d899`)
- **Title:** `feat(workflow): implement WORK-002 stage controls, skip, and rerun`
- **Delivered:** Engine-level selective node execution (`runNode`, `skipNode`, `rerunNode`) in `GraphExecutor`. Partially satisfies Issue #164 requirements at engine level.

### 2026-09-30: PR #216 (WORK-001) merged (`748334a`)
- **Title:** `feat(workflow): implement WORK-001 GraphExecutor and fan-in patch materialization`
- **Delivered:** In-memory and persisted DAG execution engine (`GraphExecutor`), parallel branch scheduling, and fan-in git patch materialization via `changeSetMerger.ts`.

### 2026-09-30: PR #215 (WORK-001) merged (`07e7fd0`)
- **Title:** `feat(workflow): implement WORK-001 branch worktree isolation and changeSetMerger`
- **Delivered:** Isolated git worktree allocation per graph branch (`WorktreeService.prepareWorktree`) preventing concurrency collisions (Q-WF-01), and three-way changeset merging.

### 2026-09-30: PR #214 merged (`e9990ef`)
- **Title:** `feat(workflow): implement M6 Phase 1 graph schemas, template compiler, and persistence`
- **Delivered:** `WorkflowTemplateV2` schemas, canonical linear template compilation (`templateCompiler.ts`), and SQLite persistence schema for workflow graphs.

### 2026-09-30: PR #213 merged (`50ea514`)
- **Title:** `docs(arch): accept ADR-007 generic workflow graph architecture and execution model`
- **Delivered:** Architectural specification establishing the Generic Workflow Graph Engine program (ADR-007).

### 2026-09-29: PR #212 merged (`383c62c`)
- **Title:** `feat(arch): implement ADR-004 architectural layering and boundary enforcement`
- **Delivered:** Dependency-cruiser architectural boundaries, cycle detection scripts, and strict subsystem layering.

### 2026-09-28: PR #211 merged (`c981988`)
- **Title:** `feat(architecture): establish artifact service authority and remove legacy artifact store (ADR-006)`
- **Delivered:** Elevated `ArtifactService` as sole authority for artifact storage and streaming; removed legacy SQLite blob storage.

### 2026-09-28: PR #210 merged (`ee0ef71`)
- **Title:** `feat(architecture): separate application read models from ipc transport (ADR-005)`
- **Delivered:** Decoupled `@shared/views` projection types from IPC transport schemas.

### 2026-09-28: PR #209 merged (`022a504`)
- **Title:** `feat: complete pre-M6 small milestones (M0-002, M0-003, AGENT-002)`
- **Delivered:** Windows git EBUSY flakiness resolution (`removeTempDir`), spike #64 formal documentation closure, and high-throughput streaming artifact ingestion.

### 2026-09-28: PR #208 (VERIFY-003) merged (`391630e`)
- **Title:** `feat(verification): add adversarial verifier (VERIFY-003)`
- **Delivered:** Independent adversarial evidence auditor (`adversarial.ts`), verifier integration (`verifier.ts`), cryptographic artifact integrity verification, and exit code 2 halt on policy violations.

### 2026-09-25: PR #207 merged (`7b91d67`)
- **Title:** `docs(project): record CRIT-001 completion after PR #204 merge`
- **Delivered:** Forensic documentation stabilization and truth baseline unification.

### 2026-09-25: PR #204 (CRIT-001) merged (`5987501`)
- **Title:** `feat(criteria, cli): implement CRIT-001 criteria evaluation & runs/artifacts inspection CLI`
- **Delivered:** CRIT-001 criteria evaluator engine, task loop integration, and `forge runs` / `forge artifacts` CLI.

### 2026-09-12: PR #203 (STATE-001) merged (`1dfb444`)
- **Title:** `feat(state): implement STATE-001 durable run, step, artifact, and event store`
- **Delivered:** SQLite schema migrations via Drizzle ORM, `RunStore`, `EventStore`, `ArtifactStore`, and filesystem `ArtifactService`.

### 2026-09-12: PR #198 (Vertical Slice #1) merged (`26ac6e3`)
- **Title:** `feat(core): Vertical Slice #1 — Headless Forge Core, Native Agent Runtime & CLI (CORE-001, AGENT-001, CLI-001, EVIDENCE-001)`
- **Delivered:** Decoupled `createForgeCore`, standalone `bin/forge.ts` CLI, native agent task loop in `taskRunner.ts`, physical git diff reconciliation.

### 2026-09-09: PR #188 & #189 merged
- **Delivered:** External CLI agent provider catalog and ConPTY terminal session hosting foundation.

---

## 4. Production Execution Reality vs Generic Graph Engine

A strict architectural distinction must be maintained between the **active production execution path** and the **generic graph engine**:

1. **Active Production Path:**
   - Production runtime entrypoint is `WorkflowService` (`src/main/workflows/workflowService.ts`).
   - `WorkflowService.startWorkflow()` and `WorkflowService.resumeWorkflow()` instantiate and run the linear `Orchestrator` (`src/main/runtimes/orchestrator.ts`).
   - Production execution path is strictly: `WorkflowService → Orchestrator`.
   - The generic graph engine (`GraphExecutor`) is **not** called by `WorkflowService`.
   - This architectural isolation is verified by automated regression tests in `src/main/workflows/graphFactory.test.ts`:
     - `"verifies createForgeCore still uses the existing Orchestrator production path"`
     - `"verifies WorkflowService still routes production execution through Orchestrator"`
     - `"verifies no IPC handler exposes GraphExecutor directly"`

2. **Generic Graph Engine Status:**
   - Resides in `src/main/workflows/` (`GraphExecutor`, `LeafRunner`, `ProductionGraphFactory`, `roleResolution.ts`).
   - Slices 5B-1A (graph factory), 5B-1B (binding resolution & role preflight), and 5B-1C Slice A (gate authorization) are merged on `main`.
   - Slice 5B-1C Slice B (reviewer routing & crash recovery) is implemented, verified (43 unit tests), and green in CI on open PR #228.
   - **Production Cutover & Parity:** Parity verification across the 31 orchestrator scenarios in `src/main/runtimes/orchestrator.test.ts` (`WORK-006`) has **not** yet been performed. The graph engine will not be declared production-active until PR #228 is merged, `WorkflowService` cutover is implemented, and all 31 parity scenarios pass against `GraphExecutor`.

3. **Parity Specifications:**
   - No separate `sidenotes-parity.md` document exists in the repository.
   - Authoritative parity criteria are defined by the 31 orchestrator scenarios in `src/main/runtimes/orchestrator.test.ts` and the contracts specified in ADR-007.

---

## 5. Milestone Taxonomy & GitHub Tracking Reconciliation

An explicit discrepancy exists between GitHub milestone numbers, GitHub milestone titles, and the internal milestone nomenclature used in documentation and PR branches:

| Entity | GitHub ID / Number | Title / Name on GitHub | Status on GitHub | Role in Documentation & Architecture |
| :--- | :--- | :--- | :--- | :--- |
| **Milestone 1** | #1 (id 17355191) | `M0 - Foundation` | Closed (0 open, 13 closed) | M0: Foundation & Quality Gates |
| **Milestone 2** | #2 (id 17355192) | `M1 - State Core` | Closed (0 open, 10 closed) | M1: State Core / Headless Core |
| **Milestone 3** | #3 (id 17355194) | `M2 - Runtime Adapters` | Open (1 open: #64, 11 closed) | M2: Native Agent Core & Adapters |
| **Milestone 4** | #4 (id 17355195) | `M3 - Workflow Engine` | Closed (0 open, 7 closed) | M3: Linear Workflow Engine |
| **Milestone 5** | #5 (id 17355196) | `M4 - Evidence and Review` | Closed (0 open, 6 closed) | M4: State, Events & Persistence |
| **Milestone 6** | #6 (id 17355197) | `M5 - Human Control Plane` | Closed (0 open, 7 closed) | M5: Verification & Criteria |
| **Milestone 7** | #7 (id 17355198) | `M6 - Polish and Scale` | Closed (0 open, 6 closed) | Early v0.1.0-alpha release milestone (closed 2026-08-26). **Not the Graph Engine.** |
| **Milestone 8** | #8 (id 17462002) | `M7 - Usability and Real Agent Wiring` | Open (2 open: #117, #138, 20 closed) | Post-alpha usability findings |
| **Milestone 9** | #9 (id 17563798) | `M8 - Live Agent Channel` | Open (4 open: #149, #153, #154, #155, 3 closed) | Streaming runtime events & tool timeline |
| **Milestone 10** | #10 (id 17563799) | `M9 - Warm Sessions and Speed` | Open (4 open: #156, #157, #158, #159, 0 closed) | Resumable agent sessions (`--resume`, `--conversation`) |
| **Milestone 11** | #11 (id 17563800) | `M10 - Interactive Control` | Open (5 open: #160, #161, #162, #163, #164, 0 closed) | Interactive human control plane & stage steering |
| **Milestone 12** | #12 (id 17575708) | `M11 - Host the Real CLI` | Open (6 open: #165, #168, #171, #172, #174, #180, 11 closed) | ConPTY terminal hosting & CLI hooks |
| **M6 Generic Workflow Graph** | *None* | *No GitHub Milestone* | N/A | ADR-007 program (`WORK-001`..`WORK-006`, PRs #213–#228). All PRs carried `milestone: null`. |

### Key Tracker Insights & Inconsistencies:
1. **GitHub entity numbering offset:** Milestone titles M0–M11 are offset by +1 from their GitHub database IDs (e.g. GitHub Milestone #11 is titled `M10 - Interactive Control`).
2. **Issue #164 resolution status:** Issue #164 ("Templates become a starting shape: run, skip, or re-run one stage") belongs to GitHub Milestone #11 (`M10 - Interactive Control`). While engine-level stage controls (`WORK-002`) were implemented in `GraphExecutor` via PR #217, the issue remains legitimately OPEN on GitHub because full issue acceptance criteria require user-facing execution / UI steering, which depends on production cutover and interactive steering (Milestone M10).
3. **Issues #64 and #178:** Documented in `docs/roadmap/milestones.md` under M0 as resolved (`DONE`), but remained open on GitHub.

---

## 6. Active Work, Dependencies, and Next Action

- **Current In-Progress Work:** PR #228 (`feat/m6-phase5-batch3-slice5b1c-reviewer-routing`, head `bdd6aa21c76d5747cd7f6bafc0bcd6dc447a395f`).
- **Dependencies:** All upstream dependencies of PR #228 are merged into `main` (PRs #221–#227).
- **Blockers:** None. PR #228 CI is completely green ([39438649157](https://github.com/mdsaif45/forge-orchestrator/actions/runs/39438649157)).
- **Immediate Next Action:**
  1. Review and merge PR #228 to `main`.
  2. Implement `WorkflowService` cutover from `Orchestrator` to `GraphExecutor` (`WORK-006`).
  3. Verify all 31 orchestrator scenarios against `GraphExecutor` to establish true milestone parity before closing M6 Phase 5.

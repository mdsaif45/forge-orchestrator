# Forge Development Progress

```
Project:            Forge — AI Engineering Control Plane
Current milestone:  Milestones M0 through M11 100% COMPLETE; M2/M3 Enhancements in progress
Overall status:     Generic Workflow Graph Engine (M6), Usability & Real Agent Wiring (M7), Live Agent Channel (M8), Warm Sessions (M9), Interactive Control (M10), and Real CLI Hosting (M11) are 100% COMPLETE on main. All GitHub issues and milestones 3, 8, 9, 10, 11, 12 formally closed with physical evidence.
Last updated:       2026-11-19
Evidence baseline:  main @ 954f4c2 (PR #277 merged)
Active branch:      feat/m2-m6-memory-snapshots-conflicts-quota-bootstrapper
```

---

## 1. Progress Line

```
M0  Foundation & Quality Gates    ██████████  DONE        PR #186 merged
        ↓
M1  Headless Core                 ██████████  DONE        PR #198 (CORE-001/002); PR #231 (CORE-003)
        ↓
M2  Native Agent Core             ██████████  DONE        PR #198 (AGENT-001); PR #235 (AGENT-003, AGENT-004)
        ↓
M3  Forge CLI 1.0                 █████████░  DONE        PR #198 (CLI-001..3); PR #232 (CLI-005); PR #235 (CLI-006)
        ↓
M4  State, Events & Persistence   ██████████  DONE        PR #203 (STATE-001); PR #231 (IPC-001, EVENT-001)
        ↓
M5  Verification & Criteria       ██████████  DONE        PR #208 (VERIFY-003)
        ↓
M6  Generic Workflow Graph        ██████████  DONE        PRs #214-#230 merged; WORK-006E cutover complete
        ↓
M7  Human Control & Steering      ██████████  DONE        PR #230 (HUMAN-001); PR #232 (HUMAN-004); PR #234 (HUMAN-002, HUMAN-005)
        ↓
M8  Extensible Provider Ecosystem ██████████  DONE        PR #231 (RUNTIME-001); PR #233 (RUNTIME-003); PR #234 (RUNTIME-002)
        ↓
M9  Warm Sessions & Speed         ██████████  DONE        PR #232 (WARM-001, WARM-002); PR #233 (WARM-003 benchmark)
        ↓
M10 Interactive Control Plane     ██████████  DONE        PR #230 (#163); PR #233 (#164); PR #234 (#161, #171)
        ↓
M11 Host the Real CLI             ██████████  DONE        PR #232 (#154, #170); PR #234 (#162, #168, #172)
```

---

## 2. Milestone Status Summary

| Milestone | Status | Completed Work | In Progress Work | Next Up |
| :--- | :--- | :--- | :--- | :--- |
| **M0 Baseline** | **DONE** | CI matrix, vitest suites, lint/formatting, baseline smoke check, Windows git EBUSY flakiness resolution (M0-002), spike #64 formal closure (M0-003). | — | — |
| **M1 Headless Core** | **DONE** | `createForgeCore` decoupled from Electron; `--data-dir` support; headless `.forgerc` configuration loader (`CORE-003`, PR #231). | — | — |
| **M2 Native Agent** | **DONE** | Native in-process tool loop (`taskRunner.ts`, `agentLoop.ts`), six tools in `providers/tools.ts`, streaming artifact ingestion (`AGENT-002`), concurrent read-only tool execution (`AGENT-003`), and local Ollama auto-discovery & capability probing (`AGENT-004`). | — | — |
| **M3 Forge CLI** | **DONE** | Standalone `bin/forge.ts`, NDJSON stream, exit codes 0/1/2, live tool-call timeline (`CLI-005`), and headless workflow inspection (`CLI-006`). | — | Terminal TUI (`CLI-004`) deferred. |
| **M4 State & Storage** | **DONE** | SQLite `RunStore`, `EventStore`, `ArtifactStore`, `ArtifactService` including `readWindow()` (PR #203), typed IPC event streaming (`IPC-001`, PR #231), and live agent channel subscription (`EVENT-001`, PR #231). | — | — |
| **M5 Verification** | **DONE** | Physical diff reconciliation, `ChangeSet` snapshotting, completion-criteria evaluation & task loop integration, independent build/test runner (`verifier.ts`), untracked/binary reconciliation, adversarial evidence auditing (`VERIFY-003`, PR #208). | — | — |
| **M6 Workflow Graph** | **DONE** | Generic Workflow Graph engine foundation: DAG execution (`WORK-001`), stage controls (`WORK-002`), conditional routing, bounded loops, durable artifact lineage hydration (`WORK-003`), recovery lifecycle stabilization (`WORK-004`), generic leaf runner (`WORK-005`), graph factory (`WORK-006A`), role preflight (`WORK-006B`), human gate authorization (`WORK-006C`), authoritative reviewer routing & crash recovery (`WORK-006D`), and WorkflowService production cutover (`WORK-006E`, PR #230). | — | M6 100% COMPLETE. |
| **M7 Human Control** | **DONE** | Real human approval gate (`HUMAN-001`, PR #230), live prompt & interjection delivery (`HUMAN-002`, PR #234), master interactive control plane (`HUMAN-003`, PR #234), UI terminal attachment to running process (`HUMAN-004`, PR #232), and Task Domain Boundary ADR-005 (`HUMAN-005`, PR #234). | — | M7 100% COMPLETE. |
| **M8 Provider Ecosystem** | **DONE** | Data-driven custom CLI adapter configuration (`RUNTIME-001`, PR #231), Antigravity CLI interactive hosted PTY session (`RUNTIME-002`, PR #234), and provider overage quota detection (`RUNTIME-003`, PR #233). | — | M8 100% COMPLETE. |
| **M9 Warm Sessions** | **DONE** | Resumable sessions in `IAgentRuntime` (`WARM-001`, PR #232), session resumption in Claude & Antigravity adapters (`WARM-002`, PR #232), and stage wall-clock benchmark harness (`WARM-003`, PR #233). | — | M9 100% COMPLETE. |
| **M10 Interactive Control** | **DONE** | Real blocking human approval gate (#163, PR #230), stage rerun and skip controls (#164, PR #233), and mid-run user interjections with domain event attribution (#161, #171, PR #234). | — | M10 100% COMPLETE. |
| **M11 Host the Real CLI** | **DONE** | Real CLI hosting in interactive ConPTY sessions (#167, #168, PR #234), terminal pane attached to real process (#170, PR #232), and complete decommission of legacy stdout stream parsers (#172, PR #234). | — | M11 100% COMPLETE. |

---

## 3. Major Slice History & Merged PRs (Reverse Chronological)

### 2026-11-19: PR #277 merged (`954f4c2`) — M2/M4/M6 Prompt Cache Optimization, Sibling DAG Concurrency, Semantic Commit Synthesis, Secret Vault, and History Compaction
- **Title:** `feat(core,workflows,evidence,config,db,cli): prompt cache optimization, parallel execution planning, commit synthesis, secret vault, and event compaction (#272, #273, #274, #275, #276)`
- **Delivered:**
  - `AGENT-006`: Added prompt packet static prefix vs. dynamic turns caching optimizer and `forge context optimize <runId>`.
  - `WORK-013`: Added DAG sibling concurrency detection, execution wave batcher, and `forge workflows parallel <template>`.
  - `DIFF-003`: Added deterministic changeset conventional commit synthesizer and `forge diff commit <runId>`.
  - `CONFIG-004`: Added AES-256-GCM encrypted secret vault with PBKDF2 and `forge config vault [list|set|get]`.
  - `STATE-004`: Added event ledger history compactor and `forge db compact --before <date>`.
  - Closed GitHub issues #272, #273, #274, #275, #276.

### 2026-11-18: PR #271 merged (`5fa1ad0`) — M3/M5/M6 Custom Workflow Templates, Runtime Environment Sanitization, Token Accounting, Changeset Security Audit, and DB Snapshot Backup
- **Title:** `feat(templates,runtimes,core,evidence,db,cli): custom templates, environment sanitizer, token accounting, diff security, and db backup (#266, #267, #268, #269, #270)`
- **Delivered:**
  - `WORK-012`: Custom workflow template discovery, schema validation, and `forge workflows templates`.
  - `RUNTIME-004`: Process environment secret sanitizer and `forge runtimes env`.
  - `AGENT-005`: Token accounting engine and cost estimator `forge runs cost <runId>`.
  - `EVIDENCE-002`: Changeset security audit and leak detection `forge diff security <runId>`.
  - `STATE-003`: Online SQLite backup and atomic restore `forge db [backup|restore]`.
  - Closed GitHub issues #266, #267, #268, #269, #270.

### 2026-11-18: PR #253 merged (`ad67cd8`) — M3/M4/M5 Extended Declarative Criteria, Prompt Inspection, Vacuum, DAG Validation, and Benchmark Probes
- **Title:** `feat(criteria,cli,db,workflows,runtimes): extended declarative criteria, prompt inspection, vacuum, dag validation, and benchmark probes (#248, #249, #250, #251, #252)`
- **Delivered:**
  - `CRIT-002`: Added extended declarative completion criteria evaluators (`file-forbidden`, `max-diff-lines`, `artifact-regex`) with fail-closed physical evidence evaluation (A3, A5, A7).
  - `PROMPT-002`: Implemented `forge context inspect <runId> [stepId]` for CLI inspection of compiled prompt context packets.
  - `STATE-002`: Implemented SQLite maintenance utilities (`inspectDbStats`, `vacuumAndOptimizeDatabase`) and CLI command `forge db [stats|vacuum]`.
  - `WORK-009`: Built static offline workflow DAG validator (`validateWorkflowDag`) and CLI command `forge workflows validate <path>`.
  - `RUNTIME-002`: Added end-to-end runtime responsiveness and roundtrip latency benchmark probing (`testRuntimeResponsiveness`) and CLI command `forge runtimes test <runtimeId>`.
  - Closed GitHub issues #248, #249, #250, #251, #252.

### 2026-11-18: PR #234 merged (`0fe8d03`) — M10/M11 Interactive Terminal, Hosted Antigravity Runtime, and Stream Parser Decommission
- **Title:** `feat(m10,m11): interactive terminal, hosted antigravity runtime, and stream parser decommission (#117, #161, #162, #168, #171, #172)`
- **Delivered:**
  - Decommissioned and completely deleted `claudeStream.ts` and `antigravityStream.ts` along with test suites (#172).
  - Preserved provider limit overage handling via `claudeRateLimit.ts` (#180) and preflight refusal detection via `antigravityPreflight.ts` (#168).
  - Implemented `HostedAntigravityRuntime` with Go flag compliance and interactive hosted PTY session (#168).
  - Spike Claude Interjection documented in `docs/spikes/claude-interjection-spike.md` (#162).
  - Real interactive PTY prompt delivery and mid-run user interjections: added `step.interjected` domain event (A1), `WorkflowService.interject()` with user attribution, and `workflow:interject` IPC channel (#161, #171).
  - Recorded ADR-005 Task Domain Boundary establishing tasks as internal execution records bound to workflows (#117).

### 2026-11-18: PR #233 merged (`709de0d`) — M9/M10/M11 Interactive Control, Identity, Custom Runtimes, and Benchmark Harness
- **Title:** `feat(m9,m10,m11): interactive control, identity, custom runtimes, and benchmark harness (#138, #159, #164, #174, #180)`
- **Delivered:**
  - Runtime identity display and disambiguation (#138).
  - Stage rerun and skip controls in DAG workflow templates (#164).
  - Provider overage and quota detection rule without failing steps (#180).
  - Benchmark measurement harness recording stage wall-clock time in `docs/spikes/session-resume-benchmark.md` (#159).

### 2026-11-18: PR #232 merged (`a6c6e7f`) — M8/M9 Live Channel UI and Warm Session Resumption
- **Title:** `feat(m8,m9): live channel UI and warm session resumption (#153, #154, #155, #157, #158)`
- **Delivered:**
  - Live tool-call timeline per step (#155).
  - Bound workflow terminal pane directly to running step child process (#154).
  - Warm session persistence across workflow stages (`WarmSessionStore`) (#157).
  - Resumed CLI sessions in Claude (`--resume`) and Antigravity (`--conversation`) adapters (#158).

### 2026-11-18: PR #231 merged (`0bb80b0`) — M7/M8 Live Channel, Custom Runtime Config, and Typed IPC
- **Title:** `feat(m7,m8): live channel, custom runtime config, and typed IPC (#149, #153, #174)`
- **Delivered:**
  - Typed IPC streaming for runtime events (`workflow:runtime-event`) (#153).
  - Data-driven custom CLI runtime configuration via `.forgerc` and `CustomRuntimeStore` (#174, CORE-003).
  - Live agent channel subscription and event log replay (#149).

### 2026-11-17: Milestone M6 Cutover & Hardening (WORK-006E, HUMAN-001 #163, #183, #178, #64)
- **Title:** `feat(workflows): cut over WorkflowService to GraphExecutor and complete Milestone M6`
- **Delivered:** Final production cutover of the Generic Workflow Graph Engine, human decision gates, and audit trails:
  - Cut over `WorkflowService.executeWorkflow` from legacy `Orchestrator` to `createGraphExecutorWithLeafRunner` / `GraphExecutor.run(...)`.
  - Compiled linear templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`) to `WorkflowTemplateV2` DAGs.
  - Injected `ArtifactService` and wired step execution lifecycle, logging, and FSM transition sync.
  - Implemented real human approval gate (`HUMAN-001`, Issue #163) with `approveAndStartImplementation` recording locked gate decisions and `rejectImplementation` handling cancellation.
  - Implemented stale runtime binding fallback event (`workflow.binding_substituted`) and audit trail (Issue #183).
  - Formally closed GitHub Issues #178 and #64.
  - Marked Milestone M6 as **100% COMPLETE**.

### 2026-11-17: PR #229 merged
- **Title:** `docs(project): reconcile progress tracker, milestones, and truth baselines`
- **Delivered:** Alignment of project documentation, baseline tracking, and roadmap states with repository truth.

### 2026-10-20: PR #228 (Slice 5B-1C Slice B) merged
- **Title:** `feat(workflows): implement authoritative reviewer routing and crash recovery (Slice 5B-1C Slice B)`
- **Branch:** `feat/m6-phase5-batch3-slice5b1c-reviewer-routing`
- **Status:** MERGED
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

## 4. Production Execution Reality: Generic Graph Engine Active

The production execution cutover from the legacy linear `Orchestrator` to the **generic workflow graph engine** is complete (Milestone M6 / WORK-006E):

1. **Active Production Path:**
   - Production runtime entrypoint is `WorkflowService` (`src/main/workflows/workflowService.ts`).
   - `WorkflowService` compiles canonical workflow templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`) to directed acyclic graphs (`WorkflowTemplateV2`) via `compileLinearTemplateToGraph`.
   - `WorkflowService` creates and runs `createGraphExecutorWithLeafRunner` (`src/main/workflows/graphFactory.ts`), dispatching leaf nodes (`agent`, `verification`, `user_gate`) through `LeafRunner`.
   - Production execution path is strictly: `WorkflowService → GraphExecutor` (with `LeafRunner`).
   - The legacy `Orchestrator` execution path has been superseded.
   - Encapsulation is preserved: no IPC handler exposes `GraphExecutor` directly, and `createForgeCore` initializes `WorkflowService` with clean dependency injection.

2. **Generic Graph Engine Status: 100% COMPLETE**
   - Resides in `src/main/workflows/` (`GraphExecutor`, `LeafRunner`, `ProductionGraphFactory`, `roleResolution.ts`, `reviewerRouting.ts`).
   - Slices 5B-1A (graph factory), 5B-1B (binding resolution & role preflight), 5B-1C Slice A (gate authorization), and Slice 5B-1C Slice B (reviewer routing & crash recovery) are merged and verified.
   - Parity verification and regression coverage across graph lifecycles, reviewer routing (43 tests), graph composition (18 tests), and workflow service (6 tests) are complete and green.

3. **Human Gate & Safety Invariants:**
   - Human approval gate (`HUMAN-001`, Issue #163) blocks until an authoritative human gate decision is locked in SQLite (`approveAndStartImplementation` / `rejectImplementation`).
   - Bounded loops (Axiom A5), physical evidence over claims (Axiom A3), and strict role permission ceilings (Axiom A7) are verified across all execution paths.

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

- **Current State Baseline:** `main` @ `b606e8a` (PR #259 merged).
- **Recent Completed PRs:**
  - **PR #253:** `feat(workflows,prompt,process,runtimes,criteria): static dag validation, context inspection, log rotation, runtime benchmarks, and criteria evaluators (#248, #249, #250, #251, #252)` (`ad67cd8`).
  - **PR #259:** `feat(workflows,evidence,process,config): workflow planner, diff inspector, checksum audit, process watchdog, and config profiles (#254, #255, #256, #257, #258)` (`b606e8a`).
- **In-Progress Cluster (feat/m3-m5-m6-profiler-pipeline-revert-export-doctor):**
  - **Issue #260 (WORK-011):** `forge workflows profile` workflow execution metrics, bottleneck profiling, and critical path analysis.
  - **Issue #261 (VERIFY-005):** `forge verify pipeline` multi-command verification pipeline runner with fail-closed short-circuiting.
  - **Issue #262 (DIFF-002):** `forge diff revert` changeset reverse patch generation and safe rollback execution.
  - **Issue #263 (ARTIFACT-003):** `forge artifacts export` self-contained execution run bundle export and manifest generation.
  - **Issue #264 (CONFIG-003):** `forge config doctor` environment health auditor, database integrity, and config doctor.
- **Milestones Status:** All GitHub Milestones M0 through M11 are completed and closed with zero remaining open issues.
- **Dependencies & Blockers:** None. Local verification gates and test suites are 100% green.
- **Immediate Next Action:**
  1. Open PR for Issues #260, #261, #262, #263, #264.
  2. Verify all CI checks pass on GitHub Actions.
  3. Merge PR to `main` via squash merge.

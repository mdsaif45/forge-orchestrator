# Milestones & Implementation Tasks

**Status:** PROPOSED
**Authority:** Planning Truth
**Last Updated:** 2026-10-20
**Baseline:** `main` @ `07d3c4b` (PR #227 merged) | Open PR: #228
**Related Architecture:** [architecture-overview.md](../architecture/architecture-overview.md)
**Related Progress:** [current-state.md](../project/current-state.md)

---

## Status Legend
- **`DONE`**: Merged to `main` and verified with passing automated tests and physical evidence.
- **`IN-PROGRESS`**: Actively under development in an open PR branch.
- **`READY`**: Fully specified, all upstream dependencies satisfied, ready for implementation.
- **`BLOCKED`**: Waiting on an incomplete upstream dependency.
- **`DEFERRED`**: Formally postponed with documented technical rationale.

---

## M0: Foundation & Quality Gates

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **M0-001** | — | P0 | **DONE** | — | Establish CI matrix, linting, formatting, and test runner baseline. | 678 baseline tests passing on Windows and Linux CI. | PR #186 |
| **M0-002** | #178 | P1 | **DONE** | — | Resolve intermittent Windows git EBUSY test failures during parallel runs. | Zero flakiness: `gitService.test.ts` uses `removeTempDir` (merged in PR #209; GitHub issue #178 remains open). | PR #209 |
| **M0-003** | #64 | P3 | **DONE** | — | Formally close obsolete spike #64 with evidence. | Closed conceptually: superseded by ADR-001 (§3 & §4) and ADR-003 (PR #209; GitHub issue #64 remains open). | PR #209 |

---

## M1: Headless Forge Core (Electron Decoupling)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CORE-001** | #199 | P0 | **DONE** | M0-001 | Decouple domain and task orchestrator from Electron runtime. | `createForgeCore` exported in `src/main/core/forgeCore.ts`. | PR #198 (`26ac6e3`) |
| **CORE-002** | #199 | P0 | **DONE** | CORE-001 | Support arbitrary data directory via `--data-dir` flag. | `resolveDataDir` verified in `src/main/core/forgeCore.test.ts`. | PR #198 (`26ac6e3`) |
| **CORE-003** | NEW | P1 | **READY** | CORE-001 | Headless configuration and environment loader (`.forgerc`). | Reads configuration without GUI context. | — |

---

## M2: Native Forge Agent Core 1.0

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **AGENT-001** | #200 | P0 | **DONE** | CORE-001 | In-process native agent task loop and tool calling engine. | `executeDirectTask` in `src/main/core/taskRunner.ts`. | PR #198 (`26ac6e3`) |
| **AGENT-002** | NEW | P1 | **DONE** | AGENT-001 | Streaming artifact ingestion (`writeArtifactStream`) for large tool output; `writeArtifact` currently buffers in memory. | `ArtifactService.writeArtifactStream()` covered by `artifactService.test.ts`. | — |
| **AGENT-003** | NEW | P1 | **READY** | AGENT-001 | Eager concurrent tool execution via `Promise.all`. | Benchmarked reduction in step wall-clock time. | — |
| **AGENT-004** | NEW | P1 | **READY** | AGENT-001 | Local Ollama auto-discovery and capability probing. | Offline execution on Qwen 2.5 coder models. | — |

---

## M3: Forge CLI 1.0 (Headless & TUI)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CLI-001** | #201 | P0 | **DONE** | AGENT-001 | Build standalone `bin/forge.ts` and `bin/forge.js` CLI entrypoints. | CLI runs tasks with zero Electron dependency. | PR #198 (`26ac6e3`) |
| **CLI-002** | #201 | P1 | **DONE** | CLI-001 | Headless NDJSON event streaming mode (`--json`). | Emits parseable line-delimited events to stdout. | PR #198 (`26ac6e3`) |
| **CLI-003** | #201 | P1 | **DONE** | CLI-001 | Clean exit code contract (0=Success, 1=Fail, 2=Halt). | Verified in `cli.test.ts`. | PR #198 (`26ac6e3`) |
| **CLI-004** | NEW | P1 | **NOT STARTED** | CLI-001 | Interactive terminal TUI for live CLI monitoring. | Multi-pane status and diff display. | — (see note below) |
| **CLI-005** | #155 | P2 | **READY** | CLI-004 | Live tool-call timeline rendering in terminal. | Tool invocation visual timeline. | — |

---

## M4: State, Events, Artifacts & Persistence

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **STATE-001** | NEW | P0 | **DONE** | CORE-002 | Dual-tier SQLite store (`RunStore`, `EventStore`, `ArtifactStore`) + disk. | `<dataDir>/artifacts/<run-id>/` + SQLite tables. | PR #203 (`1dfb444`) |
| **ARTIFACT-001** | NEW | P1 | **DONE** | STATE-001 | Windowed byte-offset artifact reader for large terminal logs. | `ArtifactService.readWindow()` covered by `artifactService.test.ts`. | PR #203 (`1dfb444`) |
| **EVIDENCE-001** | #202 | P0 | **DONE** | CORE-001 | Authoritative evidence model & git diff reconciliation. | `ChangeSet` snapshotting in `taskRunner.ts`. | PR #198 (`26ac6e3`) |
| **IPC-001** | #153 | P2 | **READY** | CORE-001 | Push runtime events over typed IPC channels to Renderer. | Real-time event streaming tests. | — |
| **EVENT-001** | #149 | P1 | **READY** | CORE-001 | Live agent channel subscription and event log replay. | Deterministic replay from event log. | — |

---

## M5: Independent Verification & Criteria Integrity

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CRIT-001** | NEW | P0 | **DONE** | EVIDENCE-001 | Durable completion criteria evaluation & task loop integration. | Criterion evaluator engine, task loop evaluation, UNKNOWN!=PASS, evidence persistence, policy-halt preservation. | PR #204 (`5987501`) |
| **VERIFY-001** | NEW | P0 | **DONE** | EVIDENCE-001 | Physical diff reconciliation enhancements (untracked & binary). | `--untracked-files=all` collection, path codepoint sorting, nested & binary scope halts with status `halted`. | PR #206 (`92e4e95`) |
| **VERIFY-002** | NEW | P1 | **DONE** | EVIDENCE-001 | Independent test & build child process execution runner. | `src/main/evidence/verifier.ts`, 14 tests in `verifier.test.ts`. | merged before this baseline |
| **VERIFY-003** | NEW | P2 | **DONE** | VERIFY-001 | Adversarial edge-case verifier auditor for boundary regressions & deceptive evidence. | `src/main/evidence/adversarial.ts`, `verify003.adversarial.test.ts` (14 tests), `adversarial.test.ts` (12 tests). Detects contradictory/stale/nonexistent evidence, diff discrepancies, false success claims, and out-of-scope breaches. | PR #208 (`391630e`) |

---

## M6: Generic Workflow Graph Engine

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WORK-001** | NEW | P0 | **DONE** | CORE-001 | DAG execution engine for Generic Workflow Graphs. | Arbitrary acyclic graph execution, branch worktree isolation, and pure fan-in patch materialization. | PR #215, PR #216 |
| **WORK-002** | #164 | P1 | **DONE** | WORK-001 | Stage run, skip, and re-run interactive controls. | Selective node execution in workflow (`runNode`, `skipNode`, `rerunNode`). Partial engine support for Issue #164. | PR #217 |
| **WORK-003** | NEW | P1 | **DONE** | WORK-001 | Conditional branching, loop edges, bounded iterations, and durable artifact lineage hydration. | Loop / retry integration tests, bounded iterations, and lineage hydration. | PR #218, PR #219, PR #220, PR #221 |
| **WORK-004** | NEW | P0 | **DONE** | WORK-003 | M6 Phase 5 Batch 1: Graph pause/recovery lifecycle stabilization and Slice 5A-1 read-model contracts. | 28 lifecycle invariant tests (`graphLifecycle.test.ts`), 25 read-model projection tests (`views.test.ts`). | PR #222 (`bcecb65`), PR #223 (`e434c1e`) |
| **WORK-005** | NEW | P0 | **DONE** | WORK-004 | M6 Phase 5 Batch 2: Generic leaf runner implementation (`leafRunner.ts`). | Injected leaf execution callback tests with fail-closed change scope and verification evidence mapping. | PR #224 (`a1964a1`) |
| **WORK-006A** | NEW | P0 | **DONE** | WORK-005 | M6 Phase 5 Batch 3 Slice 5B-1A: Production graph composition factory. | `ProductionGraphFactory` implementation wiring stores, worktrees, and leaf runner. | PR #225 (`ba77460`) |
| **WORK-006B** | NEW | P0 | **DONE** | WORK-006A | M6 Phase 5 Batch 3 Slice 5B-1B: Binding role resolution and capability preflight. | Role resolution ceilings, read-only worktrees, and file-write preflight. | PR #226 (`57cc1a2`) |
| **WORK-006C** | NEW | P0 | **DONE** | WORK-006B | M6 Phase 5 Batch 3 Slice 5B-1C Slice A: Gate-scoped human decision authorization. | Current graph-run authorization boundary and read-only worktree enforcement. | PR #227 (`07d3c4b`) |
| **WORK-006D** | NEW | P0 | **IN-PROGRESS** | WORK-006C | M6 Phase 5 Batch 3 Slice 5B-1C Slice B: Authoritative reviewer routing and crash recovery. | Reviewer lineage validation, fail-closed verdicts, conditional feedback evaluation, and recovery replay (43 unit tests). | PR #228 (`bdd6aa2`) |
| **WORK-006E** | NEW | P0 | **BLOCKED** | WORK-006D | M6 Phase 5 Batch 3: WorkflowService production cutover and 31-scenario orchestrator parity verification. | All 31 orchestrator scenarios passing against GraphExecutor; production cutover. | — |

---

## M7: Human Control & Interactive Sessions

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **HUMAN-001** | #163 | P0 | **READY** | WORK-001 | Real human approval gate (no auto-approval in production). | FSM pauses for human decision lock. | — |
| **HUMAN-002** | #171 | P1 | **BLOCKED** | ADR-003 | Send prompts and mid-run interjections to live PTY session. | Steer running agent without aborting. | — |
| **HUMAN-003** | #160 | P1 | **BLOCKED** | HUMAN-002 | Master interactive control plane epic. | Interactive control end-to-end tests. | — |
| **HUMAN-004** | #154 | P1 | **BLOCKED** | HUMAN-002 | Bind UI xterm pane directly to step child process. | UI terminal attachment and input forwarding. | — |
| **HUMAN-005** | #117 | P3 | **READY** | — | Unify Tasks page vs Workflow page UX. | Product UI resolution. | — |

---

## M8: Extensible Provider Ecosystem

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RUNTIME-001** | #174 | P1 | **READY** | ADR-001 | Data-driven custom CLI adapter configuration. | New CLI registered from JSON config. | — |
| **RUNTIME-002** | #168 | P1 | **READY** | ADR-003 | Launch Antigravity CLI interactively in hosted PTY session. | Bidirectional PTY stream to Antigravity. | — |
| **RUNTIME-003** | #180 | P2 | **READY** | ADR-001 | Provider quota and limit detection via CLI hooks. | Detects provider limit without failing step. | — |

---

## M9: Polish, Packaging & Production Hardening

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **POLISH-001** | — | P2 | **DEFERRED** | M7 | Multi-repository workspace management. | Multiple git checkouts in one workspace. | See `deferred.md` |
| **POLISH-002** | — | P2 | **DEFERRED** | M6 | Cloud synchronization and team backplanes. | Remote state replication. | See `deferred.md` |


---

## Notes on status corrections

Statuses here are set from repository evidence, not from branch titles or issue
existence. Three were corrected during the 2026-09-22 documentation audit:

- **`ARTIFACT-001` was marked IN-PROGRESS against PR #204.** `ArtifactService.readWindow()`
  is present on `main` and covered by `artifactService.test.ts`. It shipped with PR #203.
- **`VERIFY-002` was marked BLOCKED.** `src/main/evidence/verifier.ts` exists on `main`
  with 14 passing tests. It is done, and it was never blocked by `VERIFY-001`.
- **`CLI-004` was marked IN-PROGRESS against PR #204.** PR #204's diff contains no TUI
  and the repository has no Ink dependency. The branch title names `CLI-004` but does not
  deliver it. The contradiction is recorded, not silently resolved — see
  [Q-IL-01](../project/implementation-log.md#3-open-questions).

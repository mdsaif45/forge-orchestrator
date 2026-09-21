# Milestones & Implementation Tasks

**Status:** PROPOSED  
**Authority:** Planning Truth  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
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
| **M0-002** | #178 | P1 | **READY** | — | Resolve intermittent Windows git EBUSY test failures during parallel runs. | Zero flakiness in `gitService.test.ts`. | — |
| **M0-003** | #64 | P3 | **READY** | — | Formally close obsolete spike #64 with evidence. | ADR-001 / ADR-003 documentation references. | — |

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
| **AGENT-002** | NEW | P1 | **READY** | AGENT-001 | Tool output disk spill (>50KB) to `.forge/cache` to protect context. | Large diff does not exceed token limit. | — |
| **AGENT-003** | NEW | P1 | **READY** | AGENT-001 | Eager concurrent tool execution via `Promise.all`. | Benchmarked reduction in step wall-clock time. | — |
| **AGENT-004** | NEW | P1 | **READY** | AGENT-001 | Local Ollama auto-discovery and capability probing. | Offline execution on Qwen 2.5 coder models. | — |

---

## M3: Forge CLI 1.0 (Headless & TUI)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CLI-001** | #201 | P0 | **DONE** | AGENT-001 | Build standalone `bin/forge.ts` and `bin/forge.js` CLI entrypoints. | CLI runs tasks with zero Electron dependency. | PR #198 (`26ac6e3`) |
| **CLI-002** | #201 | P1 | **DONE** | CLI-001 | Headless NDJSON event streaming mode (`--json`). | Emits parseable line-delimited events to stdout. | PR #198 (`26ac6e3`) |
| **CLI-003** | #201 | P1 | **DONE** | CLI-001 | Clean exit code contract (0=Success, 1=Fail, 2=Halt). | Verified in `cli.test.ts`. | PR #198 (`26ac6e3`) |
| **CLI-004** | NEW | P1 | **IN-PROGRESS** | CLI-001 | Interactive React Ink terminal TUI for live CLI monitoring. | Multi-pane status and diff display. | PR #204 (Open) |
| **CLI-005** | #155 | P2 | **READY** | CLI-004 | Live tool-call timeline rendering in terminal. | Tool invocation visual timeline. | — |

---

## M4: State, Events, Artifacts & Persistence

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **STATE-001** | NEW | P0 | **DONE** | CORE-002 | Dual-tier SQLite store (`RunStore`, `EventStore`, `ArtifactStore`) + disk. | `.forge/artifacts/<runId>` + SQLite tables. | PR #203 (`1dfb444`) |
| **ARTIFACT-001** | NEW | P1 | **IN-PROGRESS** | STATE-001 | Windowed byte-offset artifact reader for large terminal logs. | Windowed reader tests passing without OOM. | PR #204 (Open) |
| **EVIDENCE-001** | #202 | P0 | **DONE** | CORE-001 | Authoritative evidence model & git diff reconciliation. | `ChangeSet` snapshotting in `taskRunner.ts`. | PR #198 (`26ac6e3`) |
| **IPC-001** | #153 | P2 | **READY** | CORE-001 | Push runtime events over typed IPC channels to Renderer. | Real-time event streaming tests. | — |
| **EVENT-001** | #149 | P1 | **READY** | CORE-001 | Live agent channel subscription and event log replay. | Deterministic replay from event log. | — |

---

## M5: Independent Verification & Criteria Integrity

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CRIT-001** | NEW | P0 | **IN-PROGRESS** | EVIDENCE-001 | Full 7-criteria evaluator engine (`src/shared/domain/criteria.ts`). | Evaluator passes/fails with precedence tests. | PR #204 (Open) |
| **VERIFY-001** | NEW | P0 | **READY** | EVIDENCE-001 | Physical diff reconciliation enhancements (untracked & binary). | Catches untracked files outside scope. | — |
| **VERIFY-002** | NEW | P1 | **BLOCKED** | VERIFY-001 | Independent test & build child process execution runner. | Clean exit code verification against agent claims. | — |
| **VERIFY-003** | NEW | P2 | **BLOCKED** | VERIFY-001 | Adversarial edge-case verifier agent for boundary regressions. | Fails on intentional edge-case corruptions. | — |

---

## M6: Generic Workflow Graph Engine

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WORK-001** | NEW | P0 | **BLOCKED** | CORE-001 | DAG execution engine for Generic Workflow Graphs. | Arbitrary acyclic graph execution. | — |
| **WORK-002** | #164 | P1 | **BLOCKED** | WORK-001 | Stage run, skip, and re-run interactive controls. | Selective node execution in workflow. | — |
| **WORK-003** | NEW | P1 | **BLOCKED** | WORK-001 | Conditional branching and loop edges in graph execution. | Loop / retry integration tests. | — |

---

## M7: Human Control & Interactive Sessions

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **HUMAN-001** | #163 | P0 | **BLOCKED** | WORK-001 | Real human approval gate (no auto-approval in production). | FSM pauses for human decision lock. | — |
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

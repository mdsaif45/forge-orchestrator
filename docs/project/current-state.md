# Current State & Capability Verification

**Status:** IMPLEMENTED  
**Authority:** Physical Implementation Truth  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444` (PR #203 merged)  
**Verification Baseline:** 1,125 tests passed across 96 test suites  

---

## 1. Executive Summary

Forge has successfully transitioned from an Electron-bound desktop prototype to a **headless execution platform foundation**. 

Headless Core (`createForgeCore`), native agent execution (`taskRunner.ts`), standalone CLI tooling (`bin/forge.ts`), and dual-tier SQLite persistence (`RunStore`, `ArtifactStore`, `EventStore`, `ArtifactService`) are fully merged into `main` and verified by 1,125 automated unit and integration tests.

---

## 2. Evidence-Based Capability Matrix

| Subsystem / Capability | Desired State | Current Status | Test Evidence | Physical Code Location |
| :--- | :--- | :--- | :--- | :--- |
| **Headless Core Decoupling** | Engine boots without Electron/GUI | **VERIFIED** | `forgeCore.test.ts` (10 tests) | `src/main/core/forgeCore.ts` |
| **Arbitrary Data Directory** | Support `--data-dir` for SQLite | **VERIFIED** | `forgeCore.test.ts` | `src/main/core/forgeCore.ts` |
| **Native Agent Loop** | In-process tool calling loop | **VERIFIED** | `taskRunner.test.ts` (3 tests) | `src/main/core/taskRunner.ts` |
| **CLI Tooling** | Standalone `forge run` entrypoint | **VERIFIED** | `cli.test.ts` (14 tests) | `bin/forge.ts`, `src/main/cli.ts` |
| **NDJSON Event Stream** | Machine-readable events to stdout | **VERIFIED** | `cli.test.ts` | `src/main/cli.ts` (`--json`) |
| **Clean Exit Codes** | 0=Pass, 1=Fail, 2=Halt | **VERIFIED** | `cli.test.ts`, `taskRunner.test.ts` | `src/main/cli.ts` |
| **SQLite RunStore** | Relational run and step tracking | **VERIFIED** | `runStore.test.ts` (12 tests) | `src/main/db/runStore.ts` |
| **SQLite EventStore** | Append-only domain event ledger | **VERIFIED** | `eventStore.test.ts` (24 tests) | `src/main/db/eventStore.ts` |
| **Filesystem Artifacts** | Content-addressed artifact storage | **VERIFIED** | `artifactService.test.ts` (7 tests) | `src/main/artifacts/artifactService.ts` |
| **Path Traversal Defense** | Boundary containment on artifacts | **VERIFIED** | `artifactService.test.ts` | `src/main/artifacts/artifactService.ts` |
| **SHA-256 Checksums** | Checksum verification on blobs | **VERIFIED** | `artifactService.test.ts` | `src/main/artifacts/artifactService.ts` |
| **Windowed Artifact Reader** | Byte-offset streaming for huge logs | **PARTIAL** | PR #204 (Passing in branch) | `src/main/artifacts/artifactService.ts` |
| **Physical Diff Reconciliation** | Git diff measured vs agent claims | **VERIFIED** | `reconciliation.integration.test.ts` (11 tests) | `src/shared/domain/reconcile.ts` |
| **Untracked File Scope Check** | Catch unauthorized untracked files | **VERIFIED** | `reconciliation.integration.test.ts` | `src/shared/domain/reconcile.ts` |
| **7-Criteria Engine** | Full criteria evaluation (CRIT-001) | **PARTIAL** | PR #204 (Passing in branch) | `src/shared/domain/criteria.ts` |
| **Terminal TUI (React Ink)** | Multi-pane status in terminal | **PARTIAL** | PR #204 (Passing in branch) | `src/main/tui/` |
| **Process Tree Termination** | `taskkill /T /F` on Windows timeouts | **VERIFIED** | `processManager.test.ts` (18 tests) | `src/main/processManager.ts` |
| **Secret Redaction** | Filter env vars & regex redact logs | **VERIFIED** | `processManager.test.ts` | `src/main/processManager.ts` |
| **Pre-Launch Trust** | Pre-record trust in `~/.claude.json` | **VERIFIED** | `claudeTrustStore.test.ts` | `src/main/runtimes/claudeTrustStore.ts` |
| **Linear Workflow Machine** | State machine pipeline with guards | **VERIFIED** | `orchestrator.test.ts` (31 tests) | `src/main/runtimes/orchestrator.ts` |
| **Decision Lock Gate** | Block implementation without locks | **VERIFIED** | `orchestrator.test.ts` | `src/main/runtimes/orchestrator.ts` |
| **AWAITING_USER State** | Pause workflow for human response | **VERIFIED** | `orchestrator.test.ts` | `src/main/runtimes/orchestrator.ts` |
| **Generic DAG Graph Engine** | Arbitrary graph execution | **PLANNED** | None (Milestone M6) | `src/shared/domain/workflowGraph.ts` (types only) |
| **Live PTY Steering** | Type into running agent process | **PARTIAL** | PTY tests passing; IPC wiring open | `src/main/runtimes/terminalSession.ts` |

---

## 3. Active Pull Requests & Slices

### PR #204: Vertical Slice #2 — Observability & Criteria Integrity
- **Branch:** `feat/slice-2-observability-criteria`
- **Target:** `main`
- **Status:** OPEN (Code complete, 1,132 tests passing, CI fully green)
- **Delivers:**
  - `CLI-004`: Interactive React Ink Terminal TUI.
  - `ARTIFACT-001`: Windowed byte-offset artifact reading.
  - `CRIT-001`: Full 7-criteria evaluator engine.

---

## 4. Known Bugs & Active Issues

- **Issue #178**: Intermittent Windows git `EBUSY` error when multiple test suites create/delete temporary git repositories concurrently. (Mitigated in test teardown with retry helpers).
- **Issue #183**: Stale runtime bindings in UI can fall back silently; requires explicit error surfacing.
- **Issue #180**: Hosted sessions cannot always distinguish provider token exhaustion from process hang.

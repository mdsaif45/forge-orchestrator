# Forge Development Progress

```
Project:            Forge — AI Engineering Control Plane
Current milestone:  Milestone M5 Verification & Criteria COMPLETE on main
Overall status:     Headless Core, Native Loop, CLI, SQLite persistence, and Criteria Evaluation merged.
Last updated:       2026-09-25
Evidence baseline:  main @ 5987501 (PR #204 merged) — 1,142 tests passing
Active branch:      docs/crit-001-post-merge-bookkeeping @ 9719092
```

---

## 1. Progress Line

```
M0  Foundation & Quality Gates    ██████████  DONE        PR #186 merged
        ↓
M1  Headless Forge Core           ██████████  DONE        PR #198 merged (CORE-001/002)
        ↓
M2  Native Agent Core             ██████████  DONE        PR #198 merged (AGENT-001)
        ↓
M3  Forge CLI 1.0                 ███████░░░  IN PROGRESS PR #198 (CLI-001..3); CLI-004 not started
        ↓
M4  State, Events & Persistence   ██████████  DONE        PR #203 merged (STATE-001)
        ↓
M5  Verification & Criteria       ██████████  DONE        PR #204 (CRIT-001) & PR #206 (VERIFY-001) merged
        ↓
M6  Generic Workflow Graph        ░░░░░░░░░░  NOT STARTED Types defined; engine blocked on M5
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
| **M0 Baseline** | **DONE** | CI matrix, vitest suites, lint/formatting, baseline smoke check. | — | Fix Windows git EBUSY flakiness (#178). |
| **M1 Headless Core** | **DONE** | `createForgeCore` decoupled from Electron; `--data-dir` support. | — | Headless config loader (`.forgerc`). |
| **M2 Native Agent** | **DONE** | Native in-process tool loop (`taskRunner.ts`, `agentLoop.ts`), six tools in `providers/tools.ts`. | — | Streaming artifact ingestion for large tool output (`AGENT-002`). |
| **M3 Forge CLI** | **IN PROGRESS** | Standalone `bin/forge.ts`, NDJSON stream, exit codes 0/1/2. | — no TUI work is in flight; see Q-IL-01. | Terminal TUI (`CLI-004`) not started. |
| **M4 State & Storage** | **DONE** | SQLite `RunStore`, `EventStore`, `ArtifactStore`, `ArtifactService` including `readWindow()` (PR #203). | — | Typed IPC event streaming. |
| **M5 Verification** | **DONE** | Physical diff reconciliation, `ChangeSet` snapshotting, completion-criteria evaluation & task loop integration, independent build/test runner (`verifier.ts`), untracked/binary reconciliation. | — | Adversarial edge-case verifier (`VERIFY-003`). |
| **M6 Workflow Graph** | **NOT STARTED** | Domain types declared. | — | DAG execution engine. |
| **M7 Human Control** | **NOT STARTED** | ConPTY terminal session spawner validated in spikes. | — | Attach UI pane to running session. |
| **M8 Provider Ecosystem**| **NOT STARTED** | Claude/Antigravity adapters prototyped. | — | Data-driven provider config. |
| **M9 Polish & Scale** | **NOT STARTED** | — | — | Enterprise workspace management. |

---

## 3. Major Slice History & Merged PRs

### 2026-09-25: PR #204 (CRIT-001) merged (`5987501`)
- **Title:** `feat(criteria, cli): implement CRIT-001 criteria evaluation & runs/artifacts inspection CLI`
- **Delivered:** CRIT-001 criteria evaluator engine and `taskRunner` execution loop integration; `forge runs` and `forge artifacts` inspection CLI with project scoping, UUID boundary validation, and byte-preserving base64 IPC windowed reading.
- **Tests:** 97 test files passed, 1,142 tests passed, 3 skipped.

### 2026-09-12: PR #203 (STATE-001) merged (`1dfb444`)
- **Title:** `feat(state): implement STATE-001 durable run, step, artifact, and event store`
- **Delivered:** SQLite schema migrations via Drizzle ORM, `RunStore`, `EventStore`, `ArtifactStore`, and filesystem `ArtifactService`.
- **Hardening:** Added path traversal boundary containment, atomic writes, rollback on metadata failure, and strict event sequencing.
- **Tests:** the suite stands at 1,125 passing / 3 skipped at this commit (measured). The per-PR delta was not re-measured in this documentation pass.

### 2026-09-12: PR #198 (Vertical Slice #1) Merged (`26ac6e3`)
- **Title:** `feat(core): Vertical Slice #1 — Headless Forge Core, Native Agent Runtime & CLI (CORE-001, AGENT-001, CLI-001, EVIDENCE-001)`
- **Delivered:** Extracted `createForgeCore` from Electron Main, created standalone `bin/forge.ts` CLI, implemented native agent task loop in `taskRunner.ts`, and enforced physical git diff reconciliation.
- **Issues Closed:** Closed #199, #200, #201, #202.

### 2026-09-09: PR #188 & #189 Merged
- **Delivered:** Integrated third-party CLI agent providers and PTY terminal session hosting foundations.

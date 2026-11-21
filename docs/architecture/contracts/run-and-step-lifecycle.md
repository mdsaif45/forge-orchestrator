# Contract: Run and Step Lifecycle

**Status:** FROZEN  
**Authority:** Canonical Lifecycle Contract  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [execution-model.md](../execution-model.md), [workflow-engine.md](../workflow-engine.md)  
**Related Specifications:** `docs/DOMAIN.md`  
**Related Implementation:** `src/main/db/runStore.ts`, `src/shared/domain/transitions.ts`  

---

## 1. Purpose

This contract specifies the formal state transitions, invariants, and failure semantics for execution **Runs** and workflow **Steps** managed by ForgeCore.

---

## 2. Run Lifecycle

A **Run** represents a single complete execution attempt of a Task or Workflow. In the domain and SQLite storage layer (`src/shared/domain/run.ts`, `src/main/db/schema.ts`), `runStatusSchema` defines four states:

```
                  ┌───────────────┐
                  │    RUNNING    │
                  └───────┬───────┘
        ┌─────────────────┼─────────────────┐
        │ completeRun()   │ failRun()       │ haltRun()
        ▼                 ▼                 ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │  COMPLETED   │  │    FAILED    │  │    HALTED    │
 └──────────────┘  └──────────────┘  └──────────────┘
```

> **Note on `CANCELLED`**: `CANCELLED` is a terminal `WorkflowState` (`src/shared/domain/enums.ts`), not a `RunStatus`. When an orchestrator cancels an active workflow, the run itself is recorded as `halted` or `failed` with a cancellation reason.

### Run Invariants
1. **Terminal Immutability**: Once a Run reaches `completed`, `failed`, or `halted`, its state cannot be updated. Any subsequent mutation throws `InvalidStateTransitionError`.
2. **Write-Ahead Status**: A Run starts in `running` and must be persisted in SQLite before child processes or worktrees are initialized.
3. **Run ID Format**: Run IDs are UUID strings, branded via `runIdSchema` in `src/shared/domain/ids.ts` and used directly as the SQLite primary key.

---

## 3. Step Lifecycle

A **Step** represents one unit of work within a Run bound to a specific agent role. Step records (`src/shared/domain/run.ts`) share the same four lifecycle statuses:

```
                  ┌───────────────┐
                  │    RUNNING    │
                  └───────┬───────┘
        ┌─────────────────┼─────────────────┐
        │ finishStep()    │ failStep()      │ haltStep()
        ▼                 ▼                 ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │  COMPLETED   │  │    FAILED    │  │    HALTED    │
 └──────────────┘  └──────────────┘  └──────────────┘
```

### Step Invariants
1. **Deterministic Identity & Indexing**: Step IDs are nominal UUID strings (`stepIdSchema` in `src/shared/domain/ids.ts`). The execution sequence is stored as an integer in `index` (`stepRecordSchema.index` / `run_steps.step_index`).
2. **Step Verdicts**: A completed step must record an authoritative `verdict`:
   - `pass`: Met all completion criteria and passed review.
   - `fail`: Failed test runner, compiler, or review finding.
   - `halt`: Halted due to policy violation or iteration limit.

---

## 4. Bounded Loop Invariants (Axiom A5)

1. **Max Iteration Bound**: Every workflow defines `maxIterations` (default: 3). If `iterationCount > maxIterations`, the engine terminates with `haltReason: 'LIMIT_EXCEEDED'`.
2. **No-Progress Detection**: If the SHA-256 hash of the git diff across consecutive correction steps is identical, the engine immediately terminates with `haltReason: 'NO_PROGRESS'`.
3. **Timeout Ceiling**: If execution exceeds `timeoutMs`, `ProcessManager` kills the child process tree and transitions the Step and Run to `FAILED` with `timeout: true`.

---

## 5. Verification Evidence

- `src/main/db/runStore.test.ts`: Verifies run and step insertion, updates, transitions, and query methods.
- `src/shared/domain/guards.test.ts`: Verifies state guards and transition validation.
- `src/shared/domain/transitions.test.ts`: Verifies legal and illegal transition graphs.

---

## 6. Amendment History

| Amendment | Type | Date | Reason & Evidence |
| :--- | :--- | :--- | :--- |
| **AMD-RUN-001** | CORRECTION | 2026-09-22 | Corrected Run and Step lifecycle states from 6-state speculative diagram to canonical 4-state `runStatusSchema` (`'running' \| 'completed' \| 'failed' \| 'halted'`) defined in `src/shared/domain/run.ts` lines 14-15 and stored in `runs.status` / `run_steps.status`. Clarified that `CANCELLED` is a `WorkflowState` (`src/shared/domain/enums.ts`), not a `RunStatus`. |
| **AMD-RUN-002** | CORRECTION | 2026-09-22 | Corrected Step Invariant 1: Step IDs are nominal UUID strings (`stepIdSchema` in `src/shared/domain/ids.ts`), not composite `<runId>-<index>` strings. Integer sequence is tracked by `index` (`run_steps.step_index`). |
| **AMD-RUN-003** | STABILIZATION | 2026-09-25 | Re-baselined contract to `main @ 5987501` (PR #204 merged). Confirmed 4-state run status lifecycle and SQLite invariants. |

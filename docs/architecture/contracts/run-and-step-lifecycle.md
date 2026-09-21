# Contract: Run and Step Lifecycle

**Status:** FROZEN  
**Authority:** Canonical Lifecycle Contract  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [execution-model.md](../execution-model.md), [workflow-engine.md](../workflow-engine.md)  
**Related Specifications:** `docs/DOMAIN.md`  
**Related Implementation:** `src/main/db/runStore.ts`, `src/shared/domain/transitions.ts`  

---

## 1. Purpose

This contract specifies the formal state transitions, invariants, and failure semantics for execution **Runs** and workflow **Steps** managed by ForgeCore.

---

## 2. Run Lifecycle

A **Run** represents a single complete execution attempt of a Task or Workflow.

```
                  ┌───────────────┐
                  │    PENDING    │
                  └───────┬───────┘
                          │ startRun()
                          ▼
                  ┌───────────────┐
                  │    RUNNING    │
                  └───────┬───────┘
        ┌─────────────────┼─────────────────┬─────────────────┐
        │ completeRun()   │ failRun()       │ haltRun()       │ cancelRun()
        ▼                 ▼                 ▼                 ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │  COMPLETED   │  │    FAILED    │  │    HALTED    │  │  CANCELLED   │
 └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

### Run Invariants
1. **Terminal Immutability**: Once a Run reaches `completed`, `failed`, `halted`, or `cancelled`, its state cannot be updated. Any subsequent mutation throws `InvalidStateTransitionError`.
2. **Write-Ahead Status**: Transitioning to `running` must be persisted in SQLite before child processes or worktrees are initialized.
3. **Run ID Format**: All Run IDs must be valid ULIDs (26 uppercase alphanumeric characters).

---

## 3. Step Lifecycle

A **Step** represents one unit of work within a Run bound to a specific agent role.

```
                  ┌───────────────┐
                  │    PENDING    │
                  └───────┬───────┘
                          │ startStep()
                          ▼
                  ┌───────────────┐
                  │    RUNNING    │
                  └───────┬───────┘
        ┌─────────────────┼─────────────────┬─────────────────┐
        │ finishStep()    │ failStep()      │ haltStep()      │ cancelStep()
        ▼                 ▼                 ▼                 ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │  COMPLETED   │  │    FAILED    │  │    HALTED    │  │  CANCELLED   │
 └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

### Step Invariants
1. **Deterministic Indexing**: Step IDs follow the convention `<runId>-<index>` (0-indexed).
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

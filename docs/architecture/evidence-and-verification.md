# Evidence, Verification & Reconciliation

**Status:** IMPLEMENTED  
**Authority:** Normative Evidence Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [execution-model.md](execution-model.md), [agent-runtime.md](agent-runtime.md), [contracts/verification-criteria.md](contracts/verification-criteria.md)  
**Related Implementation:** `src/main/evidence/verifier.ts`, `src/shared/domain/reconcile.ts`, `src/shared/domain/completion.ts`, `src/shared/domain/criterion.ts`, `src/main/git/gitService.ts`  

---

## 1. Axiom A3: Evidence Over Claims

The central tenet of Forge's verification architecture is **Axiom A3**:

> **Evidence > claims.** An agent saying "I modified 2 files and all tests pass" is an unverified assertion. Forge measures what git reports, runs the test command itself, and computes objective completion criteria.

```
┌──────────────────────────────────────┐       ┌──────────────────────────────────────┐
│             AGENT REPORT             │       │           PHYSICAL REALITY           │
│  "All tests pass, updated math.ts"   │       │  Git diff shows math.ts & secret.env │
│  (Zero normative weight)             │       │  npm test exited with code 1         │
└──────────────────┬───────────────────┘       └──────────────────┬───────────────────┘
                   │                                              │
                   └───────────────────────┬──────────────────────┘
                                           │
                                           ▼
                               ┌───────────────────────┐
                               │     RECONCILIATION    │
                               │  • Discrepancy logged │
                               │  • Scope breach halt  │
                               │  • Verdict: FAIL      │
                               └───────────────────────┘
```

---

## 2. Git as Objective Ground Truth

Forge interacts with git directly via `GitService` (`src/main/git/gitService.ts`).

### Why `git` is Spawned Directly, Not Wrapped
Forge executes the `git` binary directly using `child_process.execFile` with no shell (`shell: false`). It rejects library wrappers (such as isomorphic-git or nodegit) because:
1. **Behavioral Invariant**: Library implementations differ subtly from the real `git` CLI on line endings (CRLF vs LF), file mode permissions, rename detection, and `.gitignore` parsing.
2. **Security Posture**: By invoking `execFile` without a shell, argument injection via branch names or file paths is structurally impossible.
3. **Reproducibility**: If a developer runs `git diff` in their terminal, Forge sees the exact same patch text.

### Physical Reconciliation (`src/shared/domain/reconcile.ts`)
After an agent completes an implementation step, Forge runs `GitService.diff()` against the base commit SHA. The output is reconciled against the agent's report:
- **Scope Enforcement**: If the diff touches any file outside `allowedPaths` or matches `forbiddenPaths`, the engine halts immediately with `HALTED_POLICY`. A scope breach cannot be corrected by an agent; it indicates an unauthorized access attempt.
- **Untracked File Detection (`VERIFY-001`)**: Standard diffs often ignore untracked files. Forge queries `git status --porcelain` to ensure new files created by the agent are caught and evaluated against `allowedPaths`. Untracked files outside scope trigger an immediate policy halt.
- **Binary File Handling (`VERIFY-001`)**: Binary additions and modifications are detected via status and diff headers without attempting lossy UTF-8 text reconciliation. Their presence is tracked and checked against the scope policy.
- **The "Liar Scenario"**: If an agent claims it changed 3 files but git shows zero changes, or claims tests pass when they failed, Forge logs a `DISCREPANCY` event. A lie does not halt the workflow — it routes back into `CORRECTION_REQUIRED` with physical proof of the omission.

---

## 3. Evidence Runners (`src/main/evidence/verifier.ts`)

Forge executes user-configured build and test commands via dedicated evidence runners.

### Architectural Invariants of Evidence Execution
1. **Requires a Shell**: Unlike `GitService`, evidence runners **must invoke a shell** (`shell: true` or `cmd.exe / powershell / /bin/sh`) because build commands often include environment variables, pipelines (`npm test | cat`), or chained commands (`npm run build && npm test`).
2. **Process Tree Termination**: Build processes often spawn sub-processes (e.g. Node spawning Vitest workers or Webpack compilers). If a timeout fires, terminating the top-level shell leaves orphan compilers running in the background. Forge uses tree-killing logic (`taskkill /PID <pid> /T /F` on Windows, process group SIGKILL on POSIX) to guarantee clean teardown.
3. **`execFile` Completes on `close`, Not `exit`**: A process may exit while its child processes still hold stdout/stderr file descriptors open. Forge listens to the `close` event, ensuring complete output capture before evaluating results.
4. **Parsed Counts Decide Nothing**: While Forge parses test summaries (e.g. `12 passed, 0 failed`) for human display in the UI, **the exit code is the sole authority**. If Vitest outputs "12 passed" but exits with code 1 (due to an unhandled rejection or lint failure), the verdict is `fail`.

---

## 4. Completion Criteria (`src/shared/domain/criterion.ts`, `completion.ts`)

A step or task defines explicit criteria that must be satisfied before work can be declared complete. Forge evaluates seven canonical criteria kinds (`criterionKindSchema` in `src/shared/domain/enums.ts`):

| Kind | Target Verified | Evaluator Logic (`assessCompletion`) |
| :--- | :--- | :--- |
| `build` | Build command execution | Verified from `EvidenceArtifact` of kind `'build'`; exit code === 0 |
| `tests` | Test suite execution | Verified from `EvidenceArtifact` of kind `'tests'`; exit code === 0 |
| `diff-scope` | Physical file paths changed | Verified from `reconciliation.inScope` (`allowedPaths` / `forbiddenPaths`) |
| `no-assumptions` | Agent unverified assumptions | Verified from `input.report.assumptions.length === 0` |
| `reviewer-verdict` | Independent review step | Verified from `input.reviewVerdict === 'pass'` |
| `file-exists` | Mandatory file presence | Verified from `existingPaths` containing all paths in `params.paths` |
| `custom-command` | Custom script verification | Verified from `EvidenceArtifact` matching `params.command`; exit code === 0 |

### Evidence Evaluation Flow

The end-to-end evaluation pipeline operates as follows:

```
┌──────────────┐     1. Criteria declared
│     Task     │─────────────────────────────────────────────────────────────┐
└──────────────┘                                                             │
                                                                             ▼
┌──────────────┐     2. Commands executed, git diff measured    ┌─────────────────────────┐
│ System/Agent │───────────────────────────────────────────────▶│ Physical Evidence /     │
└──────────────┘                                                │ ReconcileResult         │
                                                                └────────────┬────────────┘
                                                                             │
                                                                ┌────────────▼────────────┐
                                                                │   assessCompletion()    │
                                                                │ (src/shared/domain/     │
                                                                │  completion.ts)         │
                                                                └────────────┬────────────┘
                                                                             │
                                                                ┌────────────▼────────────┐
                                                                │   CriterionResult[]     │
                                                                │ • verdict, reason,      │
                                                                │   evidenceId            │
                                                                └────────────┬────────────┘
                                                                             │
                                                                ┌────────────▼────────────┐
                                                                │      StepEvidence       │
                                                                │ • Persisted in SQLite   │
                                                                │ • Emitted in step event │
                                                                └─────────────────────────┘
```

1. **Criteria Declaration**: The task defines `completionCriteria: CompletionCriterion[]` on `Task` (`src/shared/domain/task.ts`).
2. **Physical Execution**: Forge executes build/test commands via `Verifier` (`src/main/evidence/verifier.ts`) and performs git reconciliation via `reconcile()` (`src/shared/domain/reconcile.ts`).
3. **Pure Evaluation**: `assessCompletion()` in `src/shared/domain/completion.ts` compares physical evidence artifacts and reconciliation results against the criteria.
4. **Structured Verdicts**: Each criterion produces a `CriterionResult` (`src/shared/domain/criterion.ts`) containing:
   - `kind`: Criterion kind enum
   - `description`: Human-readable description
   - `verdict`: `'pass' | 'fail' | 'unknown'`
   - `reason`: Authoritative explanation citing exit codes, missing files, or reconciliation status
   - `evidenceId`: Identifier of the backing `EvidenceArtifact`, if applicable
5. **Step Evidence Persistence**: Results are packaged into `StepEvidence` (`src/shared/domain/evidence.ts`) and persisted in SQLite via `evidenceStore`.
6. **Workflow Routing**: If any criterion fails or remains unknown, the workflow routes to `CORRECTION_REQUIRED` or halts per policy.

### Evaluator Precedence: Fail Outranks Unknown
Evaluation follows a strict precedence: **fail outranks unknown, and unknown outranks pass**:
1. If **any** criterion has `verdict === 'fail'`, the overall verdict is `fail`.
2. If any criterion has `verdict === 'unknown'` and none failed, the overall verdict is `unknown`. An unverified criterion is never assumed to pass (Axiom A3).
3. The overall verdict is `pass` **if and only if** every criterion has `verdict === 'pass'`.

---

## 5. Independent Review Step

After self-verification succeeds, Forge routes the changeset to an independent `reviewer` agent role:
- **Strict Read-Only Remit**: The reviewer cannot execute file-modifying tools.
- **Evidence-Backed Prompt**: The reviewer receives the unified diff and the physical test runner logs.
- **Structured Findings**: If the reviewer awards a `fail`, it must provide structured findings pointing to concrete `file:line` locations and explanation.
- **Immutable Corrections**: A correction prompt generated for the implementer cannot widen its scope; it must address only the findings identified by the reviewer.

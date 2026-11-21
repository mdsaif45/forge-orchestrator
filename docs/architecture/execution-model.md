# Execution Model & Lifecycle

**Status:** IMPLEMENTED  
**Authority:** Normative Execution Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [state-and-storage.md](state-and-storage.md), [evidence-and-verification.md](evidence-and-verification.md)  
**Related Contracts:** [execution-protocol.md](contracts/execution-protocol.md), [run-and-step-lifecycle.md](contracts/run-and-step-lifecycle.md)  

---

## 1. Domain Hierarchy

Forge models autonomous engineering through a strict entity hierarchy:

```
Task (What to achieve: objective, constraints, criteria)
  └── Run (One execution attempt of a Task or Workflow)
       ├── Step 1 (Discovery / Planning)
       │    ├── ContextPacket (Compiled input state)
       │    ├── ExecutionTurn(s) (Tool calls, LLM exchanges, PTY output)
       │    ├── Artifacts (Prompt, raw stdout, tool outputs)
       │    └── Events (Step started, tool called, plan emitted)
       ├── Step 2 (Decision Gate / Approval)
       │    └── Decision Lock (Human approval recorded in SQLite)
       ├── Step 3 (Implementation)
       │    ├── ExecutionTurn(s) (File modifications in isolated worktree)
       │    └── Artifacts (Patches, physical diffs, terminal logs)
       ├── Step 4 (Verification)
       │    ├── Test & Build Runners (Exit codes, output logs)
       │    └── Completion Verdict (Computed from criteria)
       └── Step 5 (Review / Reconciliation)
            └── ChangeSet Verdict (PASS ──> DONE, or FAIL ──> Step 3 Correction)
```

---

## 2. Core Execution Concepts

### 1. Task
A **Task** is the declaration of *what* needs to be accomplished.
- **Objective**: High-level goal provided by the user.
- **Constraints**: Allowed file patterns (`allowedPaths`), forbidden paths, banned commands.
- **Completion Criteria**: Objective tests and checks that must pass before the task can be marked complete (e.g. `testsPass`, `buildSucceeds`, `noUntrackedFiles`).

### 2. Run
A **Run** is a single, concrete execution instance of a Task.
- Identified by a UUID (`runId`), branded by `runIdSchema` in `src/shared/domain/ids.ts`.
- Possesses lifecycle states: `pending` → `running` → `completed` | `failed` | `halted` | `cancelled`.
- Bounded by maximum duration (wall-clock timeout) and iteration limits.
- Associated with dedicated workspace storage (`.forge/artifacts/<runId>/`).

### 3. Step
A **Step** is a discrete, atomic phase of work within a Run.
- Identified by `stepId` (`<runId>-<index>`).
- Bound to a specific **Role** from `roleSchema`: `planner`, `implementer`, `reviewer`, `tester` or `security-reviewer`.
- Bound to an **Agent Runtime** (`IAgentRuntime`).
- Receives a compiled, content-addressed **Context Packet**.
- Emits a structured step result, an optional physical changeset, and a verification verdict.

### 4. Event
An **Event** is an immutable, append-only record of something that occurred in the system.
- Stored in SQLite via `EventStore`.
- Schema: `{ id, runId, seq, type, payload, actor, timestamp }`.
- Events drive the UI in real time and enable deterministic state replay.
- Example event types: `run.started`, `step.created`, `tool.invoked`, `diff.measured`, `verification.completed`, `decision.locked`.

### 5. Artifact
An **Artifact** is a durable, content-addressed file generated during execution.
- Managed by `ArtifactService` on disk, indexed in SQLite (`ArtifactStore`).
- Types include:
  - `prompt_packet`: The exact prompt and context fed into the agent.
  - `raw_output`: Complete stdout/stderr capture.
  - `patch`: Unified git diff captured from physical disk.
  - `tool_result`: Large tool outputs (>50KB) spilled to disk to protect memory.
- Addressed by SHA-256 hash, enabling byte-offset windowed reading for massive files.

---

## 3. The Execution Lifecycle

Every execution run progresses through a deterministic lifecycle:

```
[ INIT ]
   │
   ▼
[ PREFLIGHT ] ──────────(Validation fails)──────────► [ HALTED_POLICY ]
   │
   ▼ (Worktree created, trust recorded, SQLite run recorded)
[ RUNNING ]
   │
   ├─► STEP EXECUTION (Plan ──> Implement ──> Verify ──> Review)
   │     │
   │     ├─► Agent queries user ──────► [ AWAITING_USER ] ──(Answered)──┐
   │     │                                                              │
   │     ├─► Policy breach (out of scope) ─► [ HALTED_POLICY ]          │
   │     │                                                              │
   │     ├─► Iteration cap / no progress ──► [ HALTED_LIMIT ]           │
   │     │                                                              │
   │     └─► Verification & Review PASS ────────────────────────────────┤
   │                                                                    │
   ▼                                                                    ▼
[ FINALIZING ] ◄────────────────────────────────────────────────────────┘
   │
   ▼ (Persist ChangeSet, record completion event, mark Run completed)
[ TERMINAL STATE ] (DONE | HALTED_LIMIT | HALTED_POLICY | CANCELLED)
```

### 1. Preflight
Before launching child processes, Forge executes preflight checks:
- Verify repository root and current git status.
- Ensure worktree base SHA is clean or explicitly opted into.
- Record folder trust in `~/.claude.json` (`ClaudeTrustStore`) to prevent blocking dialogs.
- Validate role bindings and capability matrices.

### 2. Step Execution Loop
Steps execute sequentially according to the workflow graph or linear stage pipeline:
1. **Context Compilation**: Forge builds the prompt packet, injecting repo rules, active decisions, relevant file snippets, and prior step feedback.
2. **Runtime Execution**: The assigned `IAgentRuntime` is invoked (either running the native agent loop or launching an external CLI).
3. **Evidence Reconciliation**: Once the runtime yields, Forge independently verifies git status, parses diffs, and evaluates test commands.
4. **Transition Decision**: The engine evaluates step verdicts against the state transition table.

### 3. Human Intervention Gate
If an agent raises an ambiguous question, or when an architectural decision requires user confirmation:
- The run transitions to `AWAITING_USER`.
- The engine records the exact prior state (`resumeState`).
- The developer responds via CLI prompt or desktop UI.
- The engine transitions cleanly back to the prior state without losing session context.

# Workflow Engine: Linear Execution & Graph Trajectory

**Status:** IMPLEMENTED (Linear Pipeline) / PROPOSED (Generic Graph Engine)  
**Authority:** Normative Workflow Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [execution-model.md](execution-model.md), [evidence-and-verification.md](evidence-and-verification.md)  
**Related Specifications:** `docs/DOMAIN.md`  
**Related Implementation:** `src/main/runtimes/orchestrator.ts`, `src/shared/domain/transitions.ts`  

---

## 1. CURRENT IMPLEMENTATION

### 1.1 The State Machine Pipeline
The current workflow engine implements a deterministic, sequential state machine formally defined in `src/shared/domain/transitions.ts` and generated in `docs/DOMAIN.md`:

```
                    DISCOVERY
                        │
                    PLANNING
                        │
                    PLAN_READY ──(user approves)──> DECISIONS_LOCKED
                        │                                │
                        │                          IMPLEMENTING
                        │                                │
                        │                          VERIFYING
                        │                                │
                        │                          REVIEWING
                        │                                │
                        │                          ┌─────┴─────┐
                        │                        PASS        FAIL
                        │                          │           │
                        │                        DONE    CORRECTION_REQUIRED
                        │                                      │
                        │                                      └──> IMPLEMENTING
                        │                                           (iteration++)
                        │
   any state ──(agent uncertain)──> AWAITING_USER ──(answer)──> resume prior state
   any state ──(limit hit)────────> HALTED_LIMIT
   any state ──(policy violation)─> HALTED_POLICY
```

### 1.2 Invariants of the Linear Machine
- **Transitions are Data**: Defined as a static lookup table in `src/shared/domain/transitions.ts`. Illegal transitions throw immediately.
- **Write-Ahead Transitions**: An event recording the state transition is committed to SQLite `workflow_events` **before** triggering child processes.
- **Terminal Guarantees & State Mapping**:
  - `WorkflowState` ends deterministically in one of four terminal states: `DONE`, `HALTED_LIMIT`, `HALTED_POLICY`, or `CANCELLED`.
  - The enclosing `RunStatus` (`src/shared/domain/run.ts`) maps these terminal states: `DONE` maps to `completed` (exit code 0); `HALTED_LIMIT` and `HALTED_POLICY` map to `halted` (exit code 2); unrecoverable system or verification failures map to `failed` (exit code 1).

### 1.3 Loop Guards & Termination Guarantees (Axiom A5)
1. **Iteration Caps**: Each workflow instance declares `maxIterations` (default: 3). The counter increments on each `correctionStarted` transition. If an agent fails verification or review after reaching the cap, the engine transitions to `HALTED_LIMIT`.
2. **No-Progress Diff Detection**: To prevent ping-pong cycling between identical patches, Forge computes the SHA-256 hash of the unified git diff at each iteration:
   ```typescript
   if (currentDiffHash === priorDiffHash) {
     haltWorkflow('NO_PROGRESS', 'Identical patch produced across consecutive correction loops');
   }
   ```
3. **Wall-Clock & Process Timeouts**: Every tool execution, child process, and overall stage is bounded by configurable timeouts. If an agent stalls or enters an infinite loop, `ProcessManager` terminates the entire child process tree.

### 1.4 Human Control Gates
1. **Decision Lock Gate (`DECISIONS_LOCKED`, Axiom A4)**: An agent cannot transition from planning to implementation on its own authority. Transition requires that the planner emits proposed decisions, the human reviews and locks at least one decision in SQLite, and the engine verifies the locked decision before allowing the state transition.
2. **Ambiguity Pause Gate (`AWAITING_USER`, Axiom A2)**: When an agent encounters ambiguous requirements, it raises an `OpenQuestion`. The engine captures the current state in `workflow.resumeState`, transitions to `AWAITING_USER`, and pauses execution until the human provides a structured response.

---

## 2. PLANNED / ROADMAP DIRECTION (Milestone M6 — NOT IMPLEMENTED)

The following concepts represent roadmap planning targets from `docs/roadmap/milestones.md` (M6: Generic DAG Workflow Engine). **There is no accepted ADR or frozen contract authorizing DAG execution.** These items are roadmap intent only and do not authorize architectural implementation:
- **Declarative Graph Schemas (M6 Planned)**: Proposed future workflow templates defining directed acyclic graphs (DAGs) using declarative node schemas (`workflowGraph.ts`) with cycle detection and topological sorting.
- **Role-Based Step Dispatch (M6 Planned)**: Proposed binding of graph nodes to abstract roles (`planner`, `implementer`, `verifier`, `reviewer`), preserving the decoupled `IAgentRuntime` boundary.
- **Preserved Safety Invariants (Binding Constraint)**: If a DAG engine is formally accepted via an ADR in the future, loop bounds (Axiom A5), human decision gates (Axiom A4), and physical evidence verification (Axiom A3) must remain strictly binding across any graph topology.

---

## 3. PROPOSED / NOT IMPLEMENTED

The following capabilities are proposed future targets and **are NOT implemented**:
- **Generic DAG Execution Engine**: Dynamic execution of arbitrary branch topologies (`dagExecutor.ts` was an early exploratory prototype, not active in production workflows).
- **Parallel Worktree Branching**: Spawning concurrent agent tasks in isolated git worktrees with automated branch joins.
- **Dynamic Graph Mutation**: Allowing running workflows to insert or bypass graph nodes mid-flight.
- **Visual Node Graph Editor**: An interactive visual canvas in the desktop UI for building arbitrary graphs.

---

## 4. UNKNOWN / DESIGN QUESTIONS

- **Q-WF-01 (Parallel Worktree Merges)**: How should parallel branch executions resolve concurrent file edits before joining a verification node?
- **Q-WF-02 (Graph Checkpointing)**: What is the minimal SQLite schema required to pause and resume arbitrary graph states without storing unbounded JSON blobs?

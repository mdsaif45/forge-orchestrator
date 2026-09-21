# Workflow Engine: Linear Execution & Graph Trajectory

**Status:** IMPLEMENTED (Linear Pipeline) / PROPOSED (Generic Graph Engine)  
**Authority:** Normative Workflow Architecture  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [execution-model.md](execution-model.md), [evidence-and-verification.md](evidence-and-verification.md)  
**Related Specifications:** `docs/DOMAIN.md`  
**Related Implementation:** `src/main/runtimes/orchestrator.ts`, `src/shared/domain/transitions.ts`  

---

## 1. The Dual-Phase Engine Architecture

Forge's workflow engine manages how multi-agent engineering workflows progress from an initial goal to completed code. The architecture is split across two evolutionary phases:

1. **Current Implementation (Linear Multi-Stage Loop)**: A battle-tested, state-machine-driven pipeline enforcing strict sequential roles (planner → decision gate → implementer → verification → reviewer).
2. **Target Roadmap (Generic DAG Graph Engine)**: A visual, modular graph platform allowing arbitrary execution nodes, parallel branches, and dynamic conditional edges.

---

## 2. Current Implementation: The State Machine Pipeline

The current engine implements the state machine formally defined in `src/shared/domain/transitions.ts` and `docs/DOMAIN.md`:

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

### Invariants of the Linear Machine
- **Transitions are Data**: Defined as a static lookup table in `src/shared/domain/transitions.ts`. Illegal transitions throw immediately.
- **Write-Ahead Transitions**: An event recording the transition is committed to SQLite **before** triggering child processes.
- **Terminal Guarantees**: Any workflow ends deterministically in one of four terminal states: `DONE`, `HALTED_LIMIT`, `HALTED_POLICY`, or `CANCELLED`.

---

## 3. Loop Guards & Termination Guarantees (Axiom A5)

Unbounded agent loops consume infinite resources without converging. Forge implements four defense layers:

### 1. Iteration Caps
Each workflow instance declares `maxIterations` (default: 3). The counter increments on each `correctionStarted` transition. If an agent fails verification or review after reaching the cap, the engine transitions to `HALTED_LIMIT`.

### 2. No-Progress Diff Detection
A capped loop is insufficient defense against cycling agents. If two agents ping-pong between identical implementations (e.g. adding and removing the same comment), they burn through the iteration cap without making progress.
Forge computes the SHA-256 hash of the unified git diff at each iteration:
```typescript
if (currentDiffHash === priorDiffHash) {
  haltWorkflow('NO_PROGRESS', 'Identical patch produced across consecutive correction loops');
}
```

### 3. Wall-Clock & Process Timeouts
Every tool execution, child process, and overall stage is bounded by configurable timeouts. If an agent stalls or enters an infinite loop, `ProcessManager` terminates the entire process tree.

---

## 4. Human Control Gates

### 1. Decision Lock Gate (`DECISIONS_LOCKED`)
An agent cannot transition from planning to implementation on its own authority. Transitioning requires that:
1. The planner emits proposed decisions.
2. The human user reviews and explicitly **locks** at least one decision in SQLite.
3. The engine verifies the existence of a locked decision before allowing the state transition.

### 2. Ambiguity Pause Gate (`AWAITING_USER`)
When an agent encounters underspecified requirements, it cannot guess (Axiom A2). It raises an `OpenQuestion` and triggers the `questionRaised` event:
- The engine captures the current state into `workflow.resumeState`.
- The run enters `AWAITING_USER` and halts active execution.
- When the human submits an answer, the engine resumes exactly into `resumeState`.

---

## 5. Evolution to Generic DAG Workflows (Roadmap M6)

As specified in Epic #164 and Milestone M6, Forge is evolving toward a modular DAG workflow engine:
- **Node Primitives**: Individual steps become modular nodes (`AgentNode`, `CommandNode`, `GateNode`, `ScriptNode`).
- **Graph Topology**: Defined by declarative JSON/YAML schemas supporting acyclic directed graphs.
- **Parallelism**: Independent branches (such as concurrent test runners or multi-perspective reviewers) execute in parallel worktrees.
- **Preserved Safety**: The loop guards, scope boundaries, and human gates developed for the linear machine remain binding across graph topologies.

# The User Workflow & Developer Loop

**Status:** ACCEPTED  
**Authority:** Canonical Workflow Specification  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [execution-model.md](../architecture/execution-model.md), [workflow-engine.md](../architecture/workflow-engine.md)  
**Related Product Documents:** [north-star.md](north-star.md), [vision.md](vision.md)  

---

## 1. Overview

Forge is designed around the empirical reality of how experienced software engineers work with AI coding agents: **the human watches, steers, and decides, while the system manages execution, transport, and verification.**

```
                                  [ User Goal ]
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           1. DISCOVERY & PLANNING                             │
│  • Agent 'planner' receives strict read-only scope (Axioms A1, A2, A7)        │
│  • Probes codebase, tests, and configuration                                  │
│  • User iterates with planner until the approach has grip                     │
│  • Emits structured plan packet and proposed architectural decisions          │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           2. DECISION LOCK GATE                               │
│  • User reviews proposed decisions and locks them into SQLite (Axiom A4)      │
│  • Transition to implementation mode enforces >= 1 locked decision            │
│  • Emits 'workflow.mode_transition' audit event                               │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           3. IMPLEMENTATION PHASE                             │
│  • Agent 'implementer' authorized to modify declared paths in isolated worktree│
│  • Checkpoint written to SQLite before side effects (Crash Resilient)         │
│  • User sees live terminal output; can interject or steer mid-flight          │
│  • Changes measured against base commit SHA                                   │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           4. CRITERIA SELF-VERIFICATION                       │
│  • Forge executes real build & test commands (Axiom A3: Evidence, not claims) │
│  • Physical diffs inspected; untracked or forbidden paths caught              │
│  • If verification fails, loops to CORRECTION_REQUIRED (bounded by Axiom A5)  │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           5. INDEPENDENT CODE REVIEW                          │
│  • Agent 'reviewer' audits unified git diff + physical test evidence          │
│  • Review findings compiled into structured ChangeSet records                 │
│  • PASS ──> DONE                                                              │
│  • FAIL ──> CORRECTION_REQUIRED (with actionable feedback packet)             │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           6. HUMAN REVIEW & FINISH                            │
│  • User inspects final changeset via Changes Review UI or CLI diff inspect    │
│  • User decides whether to commit, merge, or discard worktree                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The Core Stages in Detail

### Stage 1: Discovery & Planning
- The developer prompts the `planner` role with a problem statement.
- The planner inspects repository context under strict read-only permissions.
- If the problem is ambiguous, the planner raises an `OpenQuestion` rather than guessing.
- The human iterates with the planner across turns until the design is solid.

### Stage 2: Decision Lock Gate
- The plan produces concrete proposed decisions (e.g. "Use SQLite for metadata, filesystem for blobs").
- The developer reviews, modifies, and explicitly **locks** decisions.
- Progression to implementation requires at least one locked decision, ensuring work cannot start without human alignment.

### Stage 3: Implementation & Live Steering
- The `implementer` agent is spawned against an isolated git worktree (`.forge/worktrees/<run-id>`).
- The developer has real-time visibility into tool calls, bash invocations, and thinking.
- Rather than waiting for the entire stage to end, the developer can send steering interjections into the running process.

### Stage 4: Objective Physical Verification
- The engine runs the project's build and test commands directly via child processes.
- The engine checks git status:
  - Did the agent modify files outside `allowedPaths`? (Halts with `HALTED_POLICY`).
  - Did the agent leave uncommitted broken state? (Halts or routes to correction).
  - Did the tests pass?

### Stage 5: Independent Review
- A separate `reviewer` model is invoked with the physical diff and the verified test logs.
- The reviewer cannot edit files; its only output is a structured verdict (`pass` or `fail` with concrete finding locations).
- If review fails, the engine transitions to `CORRECTION_REQUIRED`, injecting the feedback into a bounded correction loop.

### Stage 6: Human Merge Gate
- Once the automated loop reaches `DONE`, the developer reviews the finalized diff.
- The developer retains final authority to merge the branch into `main` or reject the changeset.

---

## 3. Dual Execution Interfaces

The workflow is accessible through two complementary interfaces:
1. **Headless CLI (`forge run`)**: Optimized for CI/CD pipelines, headless background runs, terminal users, and scripted automation. Emits structured NDJSON events.
2. **Desktop UI (Electron)**: Visual control plane with real-time interactive terminal panes (ConPTY/xterm), visual state machine graph, diff viewer, and interactive decision cards.

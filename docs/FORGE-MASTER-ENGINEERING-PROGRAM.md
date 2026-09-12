# FORGE — MASTER ENGINEERING PROGRAM
## Native Agent + Universal Agent Runtime + Engineering Control Plane + Lego Workflow System

**Maintainer**: Principal Architect & Staff Software Engineer  
**Repository**: `mdsaif45/forge-orchestrator` (`d:\my-quests\side-projects\Forge`)  
**Status**: Authoritative Master Program & Implementation Backlog (Post-Correction Pass)  
**Evidence Standard**: Grounded in 678 passing automated tests, verified codebase contracts, and factually audited GitHub issues (87 closed, 24 open).

---

## 1. Executive Summary

Forge is evolving from an Electron-hosted multi-agent desktop application into an enterprise-grade **Engineering Control Plane and Autonomous Native Coding Agent**.

### The Absolute Architectural Principle
> **"Forge does not own intelligence. Forge owns execution, state, coordination, evidence, policy, and truth."**

Agents supply non-deterministic cognitive intelligence. Forge supplies deterministic governance, physical ground-truth verification, cryptographic auditability, and execution safety.

### The Five Invariant Pillars
1. **Forge Engine**: The generic control plane (state machine, generic workflow graph executor, evidence system, physical git reconciliation, policy gate).
2. **Forge Agent**: The native autonomous coding worker (ReAct loop, 15 sandboxed tools, local Ollama / API models, offline-first).
3. **Agent Runtime**: The universal capability contract (`IAgentRuntime`) that any worker must implement.
4. **Agent Adapter**: Thin translation bridges connecting external agents (Claude Code, Codex, OpenCode, Kilo, Cline, Antigravity, scripts).
5. **Workflow**: The user-composed Lego graph of executable nodes (Agent, Human, Verification, Router, Script) with dependencies, conditions, loops, and budget policies.

---

## 2. Current Forge Reality (Forensic Baseline)

### Test Verification Status (`npm test`)
```
+---------------------------------------------------------------------------------------------------------------+
| Test Suite                     | Files | Tests Passed | Tests Failed | Execution Time | Notes                 |
+---------------------------------------------------------------------------------------------------------------+
| src/shared/domain              | 15    | 316          | 0            | 751ms          | 100% pure Zod FSM     |
| src/main/providers             | 6     | 124          | 0            | 1.76s          | Tools & Chat streaming|
| src/main/runtimes              | 22    | 238          | 0 (2 skip)   | 20.07s         | Orchestrator & runners|
| Total Verified Core Tests      | 43    | 678          | 0            | 22.58s         | Rock-solid baseline   |
+---------------------------------------------------------------------------------------------------------------+
```

### Verified Implementation Status
- **State Machine FSM (`src/shared/domain/transitions.ts`)**: `[SOURCE VERIFIED]` 18 strictly typed states (`PROMPT_INGESTED`, `PLAN_REQUESTED`, `TASK_DISPATCHED`, `AGENT_RUNNING`, `VERIFICATION_RUNNING`, `RECONCILIATION_RUNNING`, `DONE`, `HALTED_POLICY`).
- **Physical Diff Reconciliation (`src/main/runtimes/orchestrator.ts:75-99`)**: `[SOURCE VERIFIED]` `measureChange()` calls real `git diff`; `reconcileStep()` checks claimed files against the filesystem. Any out-of-scope modification triggers an immediate `HALTED_POLICY` transition.
- **Anti-Rationalization ReAct Loop (`src/main/providers/agentLoop.ts`)**: `[SOURCE VERIFIED]` 10-round bounded ReAct loop with `requireOneOf` anti-rationalization nudges (*"Describing the change is not making it. Call write_file now."*) and reasoning buffer extraction for empty completions.
- **Tool Suite (`src/main/providers/tools.ts`)**: `[SOURCE VERIFIED]` 15 core tools including filesystem read/write, directory search, grep, bash execution, task board tools, plan mode toggles, and subagent messaging.
- **Workflow Graph Schema (`src/shared/domain/workflowGraph.ts`)**: `[SOURCE VERIFIED]` Zod schema defining nodes (`agent`, `user_gate`, `verification`, `router`), input slots, output contracts, and dependency edges.
- **Storage Layer (`src/main/db/schema.ts`)**: `[SOURCE VERIFIED]` Drizzle SQLite schema with append-only event log (`events`), content-addressed packet store (`packetStore.ts`), change sets, evidence artifacts, tasks, workflows, and decisions.

---

## 3. Architecture Conflicts Found

1. **Electron Lifecycle Coupling**: `src/main/index.ts` initializes SQLite, Git services, and IPC handlers inside the Electron app lifecycle (`app.whenReady()`). The Engine and Native Agent cannot currently run headlessly without Electron.
2. **Hardcoded FSM vs. Generic Workflow Graph**: While `workflowGraph.ts` defines generic nodes and edges, `orchestrator.ts` currently only drives the linear hardcoded state machine (`transitions.ts`).
3. **Context Truncation & Memory Limits**: `agentLoop.ts` does not yet have a generic artifact-spilling mechanism for large tool results (>50KB).
4. **Turn-Level Checkpoints Missing**: While Forge reconciles changes per step, it lacks an instant 1-click turn-by-turn rewind model (`refs/forge/checkpoints/`).

---

## 4. GitHub Issue Audit & Factual Status

A live query of the GitHub repository (`mdsaif45/forge-orchestrator`) confirms:
- **Total Issues**: 111
- **Currently Closed on GitHub**: 87
- **Currently Open on GitHub**: Exactly 24

All 24 open issues are physically open on GitHub today. None are deleted. Below is the authoritative triage and reconciliation table:

```
+-------------------------------------------------------------------------------------------------------------------------------------+
| Issue | Title                                             | GH State | Alignment | Recommended Action | Area     | Pri | Target M |
+-------------------------------------------------------------------------------------------------------------------------------------+
| #183  | Stale runtime binding silently falls back         | OPEN     | 🟢 Strong | KEEP + REFRAME     | runtime  | P1  | M8       |
| #180  | Hosted session cannot tell provider limit spent   | OPEN     | 🟡 Reframe| KEEP + REFRAME     | adapter  | P2  | M9       |
| #178  | Two git-dependent tests fail intermittently       | OPEN     | 🟢 Strong | KEEP + FIX         | testing  | P1  | M0       |
| #174  | Custom CLI dialog: runtime configured from data   | OPEN     | 🟢 Strong | KEEP + PROMOTE     | runtime  | P1  | M8       |
| #172  | Delete stdout parsers once hooks replace them     | OPEN     | 🟡 Reframe| KEEP + REFRAME     | adapter  | P3  | M9       |
| #171  | Send prompts and mid-run interjections to live ses| OPEN     | 🟢 Strong | KEEP + PROMOTE     | runtime  | P1  | M7       |
| #168  | Launch Antigravity CLI interactively into session | OPEN     | 🔵 Defer  | DEFER TO ADAPTER   | adapter  | P2  | M9       |
| #165  | EPIC M11 — Host the real CLI instead of headless  | OPEN     | 🟢 Strong | KEEP + REFRAME     | runtime  | P1  | M9       |
| #164  | Templates starting shape: run, skip, re-run stage | OPEN     | 🟢 Strong | KEEP + PROMOTE     | workflow | P1  | M6       |
| #163  | Make human approval gate real (stop auto-approve) | OPEN     | 🟢 Strong | KEEP + BLOCKER     | engine   | P0  | M7       |
| #162  | SPIKE: Claude CLI mid-session input research      | OPEN     | 🟡 Reframe| KEEP + RESEARCH    | adapter  | P2  | M9       |
| #161  | Interject: send message to running step           | OPEN     | 🟢 Strong | CONSOLIDATE w/ #171| runtime  | P2  | M7       |
| #160  | EPIC M10 — Interactive control: steer running     | OPEN     | 🟢 Strong | KEEP + REFRAME     | engine   | P1  | M7       |
| #159  | Benchmark harness: wall-clock per stage vs manual | OPEN     | 🔵 Defer  | KEEP + DEFER       | testing  | P2  | M12      |
| #158  | Resume real CLI sessions in both adapters         | OPEN     | 🟢 Strong | KEEP + REFRAME     | adapter  | P2  | M9       |
| #157  | IAgentRuntime resumable session outlives step     | OPEN     | 🟢 Strong | KEEP + PROMOTE     | runtime  | P1  | M8       |
| #156  | EPIC M9 — Warm sessions: stop cold-context cost   | OPEN     | 🟢 Strong | KEEP + REFRAME     | runtime  | P2  | M8       |
| #155  | Show live tool-call timeline per step             | OPEN     | 🟡 Reframe| KEEP + REFRAME     | ui / cli | P2  | M3       |
| #154  | Bind workflow terminal to running step            | OPEN     | 🟢 Strong | KEEP               | ui       | P1  | M7       |
| #153  | Push runtime events to renderer over typed IPC    | OPEN     | 🟢 Strong | KEEP               | ipc      | P2  | M4       |
| #149  | EPIC M8 — Live agent channel: see work happen     | OPEN     | 🟢 Strong | KEEP + REFRAME     | engine   | P1  | M4       |
| #138  | Agent instances need own persona identity         | OPEN     | 🟡 Reframe| KEEP + REFRAME     | runtime  | P2  | M8       |
| #117  | Build Tasks page or decide Tasks is not user-face | OPEN     | 🟡 Reframe| KEEP + DECISION    | ui       | P3  | M7       |
| #64   | Re-run authenticated leg of #20 spike             | OPEN     | 🔴 Obsolete| CLOSE WITH EVIDENCE | runtime  | P3  | M0       |
+-------------------------------------------------------------------------------------------------------------------------------------+
```

---

## 5. Standardized Label Strategy

Labels in `mdsaif45/forge-orchestrator` are categorized across 5 strict dimensions:
- **`type:*`**: `type:bug`, `type:feature`, `type:architecture`, `type:research`, `type:refactor`, `type:test`, `type:docs`.
- **`area:*`**: `area:engine`, `area:agent`, `area:runtime`, `area:workflow`, `area:cli`, `area:state`, `area:evidence`, `area:adapter`, `area:security`, `area:ui`.
- **`priority:*`**: `priority:P0` (Blocker), `priority:P1` (High), `priority:P2` (Medium), `priority:P3` (Low), `priority:P4` (Future).
- **`status:*`**: `status:blocked`, `status:ready`, `status:in-progress`, `status:needs-review`.
- **`provider:*`**: `provider:claude`, `provider:codex`, `provider:opencode`, `provider:kilo`, `provider:cline`, `provider:antigravity`, `provider:local`.

---

## 6. Milestone Strategy (M0 – M12)

```
M0: Architecture & Baseline Reconciled [CURRENT]
 └─► M1: Headless Forge Core (Electron Decoupling)
      └─► M2: Native Forge Agent Core 1.0
           └─► M3: Forge CLI 1.0 (Headless & Interactive TUI)
                └─► M4: State, Events, Artifacts & Evidence System
                     └─► M5: Independent Verification & Ground-Truth Reconciliation
                          └─► M6: Generic Workflow Graph Engine
                               └─► M7: Human Control & Interactive Sessions
                                    └─► M8: Universal Agent Runtime & Registry
                                         └─► M9: External Agent Adapters
                                              └─► M10: Workspace Isolation & Policy-Governed Concurrency
                                                   └─► M11: Workflow DSL, Templates & Optimization
                                                        └─► M12: Empirical Benchmarking & Hardening
```

---

## 7. Master Issue Dependency Graph

```
                                 [M0: Reconciled Baseline]
                                             │
                                             ▼
                             [CORE-001: Headless Forge Core]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
         [AGENT-001: Native Agent Core]               [STATE-001: Event/Artifact Store]
                       │                                           │
                       ▼                                           ▼
            [CLI-001: Forge CLI 1.0]                  [EVIDENCE-001: Evidence Contract]
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                                [VERIFY-001: Physical Verification]
                                             │
                                             ▼
                               [WORKFLOW-001: Generic Workflow Graph]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
        [HUMAN-001: Human Approval Gate]             [RUNTIME-001: Universal Runtime]
                       │                                           │
                       │                                           ▼
                       │                             [ADAPTER-001: Generic CLI Adapter]
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                        [PARALLEL-001: Policy-Governed Concurrency]
                                             │
                                             ▼
                           [COMPOSE-001: Workflow DSL & Templates]
                                             │
                                             ▼
                          [BENCH-001: Empirical Reproducible Suite]
```

---

## 8. Master Implementation Backlog (Concrete Issues)

### Milestone 1: Headless Forge Core
- **`CORE-001`**: Extract `src/shared/domain` and `src/main/runtimes/orchestrator.ts` into headless Node.js modules runnable without Electron.
- **`CORE-002`**: Decouple SQLite storage from Electron `app.getPath('userData')` to support arbitrary `--data-dir`.
- **`CORE-003`**: Build headless configuration and environment loader.

### Milestone 2: Native Forge Agent Core 1.0
- **`AGENT-001`**: Native Forge Agent Core Loop & Execution Lifecycle (lifecycle, model interface, tool interface, bounded ReAct loop, cancellation, result contract).
- **`AGENT-002`**: Tool output disk spilling for results exceeding 50KB to `.forge/cache/`.
- **`AGENT-003`**: Concurrent tool execution (`Promise.allSettled`).
- **`AGENT-004`**: Local Ollama / LM Studio auto-discovery & capability negotiation.

### Milestone 3: Forge CLI 1.0
- **`CLI-001`**: Build `bin/forge.ts` command entrypoint (`forge run`, `forge verify`, `forge evidence`).
- **`CLI-002`**: Headless NDJSON event streaming mode for CI/CD with clean process exit codes.
- **`CLI-003`**: Interactive terminal TUI with React Ink.

### Milestone 4: State, Events, Artifacts & Evidence System
- **`STATE-001`**: Expand SQLite schema for structured artifact storage (`artifacts/`).
- **`ARTIFACT-001`**: Implement disk-spilled artifact store with byte-offset reading.
- **`EVIDENCE-001`**: Authoritative Evidence Model & Domain Contract (separating Creation, Persistence, Verification, and Presentation).

### Milestone 5: Independent Verification & Ground-Truth Reconciliation
- **`VERIFY-001`**: Enhance `measureChange()` and `reconcileStep()` to handle untracked files, deletions, and file renames.
- **`VERIFY-002`**: Implement independent test and build runners that record authoritative `EvidenceArtifact` rows.
- **`VERIFY-003`**: Add adversarial test generator verifying boundary conditions.

### Milestone 6: Generic Workflow Graph Engine
- **`WORKFLOW-001`**: Implement DAG execution engine for generic workflow graphs (nodes, edges, dependencies, slots).
- **`WORKFLOW-002`**: Enable stage skipping, re-running, and pause/resume (resolves #164).
- **`WORKFLOW-003`**: Implement conditional edge routing and retry loops.

### Milestone 7: Human Control & Interactive Sessions
- **`HUMAN-001`**: Implement real human approval gate pausing state machine until approval/rejection (resolves #163).
- **`HUMAN-002`**: Implement mid-turn user steering (`steer` vs `queue`) into live agent sessions (resolves #160, #171).
- **`HUMAN-003`**: Implement interactive question resolution.

### Milestone 8: Universal Agent Runtime & Registry
- **`RUNTIME-001`**: Finalize `IAgentRuntime` contract with warm session support (`resumeKey`, resolves #157).
- **`RUNTIME-002`**: Implement capability-based agent selection and fallback truth (resolves #183).
- **`RUNTIME-003`**: Define agent persona identity and binding configuration (resolves #138).

### Milestone 9: External Agent Adapters
- **`ADAPTER-001`**: Implement `GenericCliAgentRuntime` configured from JSON data (resolves #174).
- **`ADAPTER-002`**: Refactor Claude Code CLI adapter to interact via PTY and hooks (resolves #165, #172, #180).
- **`ADAPTER-003`**: Implement Antigravity CLI adapter (resolves #168).

### Milestone 10: Workspace Isolation & Policy-Governed Concurrency
- **`PARALLEL-001`**: Policy-governed concurrency controller (dependency readiness, CPU/memory limits, provider rate limits, join semantics).
- **`PARALLEL-002`**: Workspace isolation manager (temporary directories, Git worktrees, process boundaries).
- **`PARALLEL-003`**: Merge & conflict reconciliation policy.

### Milestone 11: Workflow DSL, Templates & Optimization
- **`COMPOSE-001`**: Human-editable YAML workflow format and validation.
- **`COMPOSE-002`**: Parameterized reusable sub-workflows.
- **`AGENT-005`**: Provider prompt-cache optimization (Anthropic / OpenAI static-prefix alignment).

### Milestone 12: Empirical Benchmarking & Hardening
- **`BENCH-001`**: Reproducible benchmark suite (fixed repo snapshots, fixed tasks, warm/cold accounting, raw artifact capture, resolves #159).

---

## 9. Competitor Research Matrix

Competitor research represents **research inputs for architectural evaluation**, NOT features to blindly copy:

```
+-------------------------------------------------------------------------------------------------------------------------------+
| System        | Mechanism               | Source Evidence           | Classification  | Forge Architectural Strategy          |
+-------------------------------------------------------------------------------------------------------------------------------+
| Claude Code   | Prefix Prompt Caching   | src/query.ts:1-150        | [DEFER / ADAPT] | Provider optimization in M11 (AGENT-5)|
| Claude Code   | Tool Output Disk Spill  | toolResultStorage.ts:1-80 | [ADAPT]         | Generic Artifact system (ARTIFACT-001)|
| Claude Code   | Adversarial Verification| verificationAgent.ts:1-120| [ADAPT]         | Anti-rational verifier in M5 (VERIFY-3)|
| Cline         | Shadow Git Checkpoints  | checkpointManager.ts:1-200| [RESEARCH/ADAPT]| Generic Checkpoint model (STATE-001)  |
| Kilo Code     | Worktree Subagents      | agent-manager.ts:55-74    | [RESEARCH/ADAPT]| WorkspaceIsolation in M10 (PAR-002)   |
| Kilo Code     | LanceDB Vector Indexing | indexing.ts:1-120         | [DEFER]         | Evaluate after core stability         |
| OpenCode      | Fiber Tool Concurrency  | llm.ts:257-278            | [ADAPT]         | Promise.allSettled concurrency in M2  |
| OpenCode      | Live Mid-Turn Steering  | llm.ts:390-413            | [ADAPT]         | steer vs queue in M7 (HUMAN-002)      |
+-------------------------------------------------------------------------------------------------------------------------------+
```

---

## 10. First Implementation Target: Vertical Slice #1

Vertical Slice #1 validates the end-to-end architecture with minimal complexity. **Prompt caching, worktrees, external adapters, TUI polish, and advanced concurrency are NOT prerequisites for Slice #1**:

```
[Terminal CLI: forge run "Inspect this repo and explain X"]
                           │
                           ▼
                 [Headless Forge Core] (CORE-001)
                           │
                           ▼
                 [Forge Native Agent] (AGENT-001)
                           │
                 [Bounded ReAct Loop]
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
          [Local Model/API]   [15 Sandboxed Tools]
                 │                   │
                 └─────────┬─────────┘
                           │
                           ▼
             [Physical Evidence & Verification] (EVIDENCE-001)
                           │
                           ▼
                [Terminal Result Output]
```

### Issues Executed in Slice #1:
1. **`CORE-001`**: Headless Engine initialization without Electron.
2. **`AGENT-001`**: Native Forge Agent core loop and execution lifecycle.
3. **`CLI-001`**: Standalone `bin/forge.ts` executing tasks and streaming results.
4. **`EVIDENCE-001`**: Authoritative evidence model capturing physical results.

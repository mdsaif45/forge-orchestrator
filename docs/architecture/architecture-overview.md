# System Architecture Overview

**Status:** IMPLEMENTED  
**Authority:** Canonical System Architecture  
**Last Updated:** 2026-11-26  
**Baseline:** `main` @ `cfb0f4c` (PR #488 merged)  
**Related Decisions:** [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md), [ADR-002](../decisions/ADR-002-interactive-orchestration.md), [ADR-003](../decisions/ADR-003-host-the-real-cli.md), [ADR-008](../decisions/ADR-008-modular-monorepo-workspace-architecture.md)  
**Related Implementation:** `packages/forge-core/src/core/forgeCore.ts`, `packages/forge-cli/src/cli.ts`, `packages/forge-desktop/src/main/index.ts`  

---

## 1. What is Forge?

Forge is an **AI engineering control plane** that orchestrates multiple autonomous coding agents collaborating on a software repository under a shared execution protocol.

Forge is built on a fundamental structural boundary:
- **Forge owns the state**: Git repositories, worktrees, SQLite event logs, structured artifacts, and physical diffs.
- **Agents are workers**: Ephemeral, replaceable runtime processes bound to capability-checked roles (`planner`, `implementer`, `reviewer`, `tester`, `security-reviewer`).
- **The Developer owns decisions**: Architectural direction, high-level approvals, and answers to ambiguous blockers.

```
┌────────────────────────────────────────────────────────────────────────┐
│                              CLIENT TIER                               │
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │ Standalone CLI (@forge/cli│      │ Desktop Shell (@forge/desk) │   │
│   │ bin/forge.ts              │      │ renderer/ (React 19 + UI)   │   │
│   │ NDJSON stream · TUI       │      │ ContextBridge Preload       │   │
│   └─────────────┬─────────────┘      └──────────────┬──────────────┘   │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │                                   │
                  ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     HEADLESS CORE (@forge/core)                        │
│                        createForgeCore(...)                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Core Orchestration & DAG Execution                             │   │
│   │ taskRunner.ts · WorkflowService · GraphExecutor · LeafRunner   │   │
│   └──────┬──────────────────────┬──────────────────────┬───────────┘   │
│          │                      │                      │               │
│          ▼                      ▼                      ▼               │
│   ┌──────────────┐       ┌──────────────┐       ┌──────────────┐       │
│   │ Evidence &   │       │ Dual-Tier    │       │ @forge/      │       │
│   │ Verification │       │ Persistence  │       │ runtimes     │       │
│   │ GitService   │       │ RunStore     │       │ IAgentRuntime│       │
│   │ Diff Recon   │       │ ArtifactStore│       │ Native Agent │       │
│   │ Test Runner  │       │ EventStore   │       │ ConPTY / CLI │       │
│   └──────────────┘       └──────────────┘       └──────────────┘       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Engine vs. Agent Responsibility

A critical design error in early agent orchestrators is delegating state tracking and verification to the agents themselves. Forge enforces a strict division of responsibility:

| Capability | Engine (Forge) Responsibility | Agent Responsibility |
| :--- | :--- | :--- |
| **Truth & State** | Authoritative. Owns git commit history, SQLite event logs, artifact hashes, and step runs. | Ephemeral. Maintains internal reasoning context only during its active turn. |
| **Verification** | Authoritative. Spawns compilers and test suites, computes exit codes, and reconciles physical git diffs. | Claims only. May report what it attempted, but its statements have zero normative weight (A3). |
| **Permissions** | Enforces least-privilege role boundaries (e.g. a `planner` lacks `file-write`; an `implementer` may not touch out-of-scope paths). | Complies with boundaries or faces immediate termination (`HALTED_POLICY`). |
| **Execution** | Manages child process trees, timeouts, orphaned process reaping after crash, and terminal PTY multiplexing. | Executes assigned instructions within assigned constraints. |

---

## 3. Major System Subsystems (`packages/`)

### 1. Pure Domain & Contracts (`packages/forge-shared`)
Zero-dependency TypeScript domain models (`domain/`), state machine transition table (`transitions.ts`), view DTOs (`views.ts`), and typed IPC request/response schemas (`ipc.ts`).

### 2. Headless Forge Core (`packages/forge-core`)
The foundational execution engine (`createForgeCore`), completely decoupled from Electron:
- **Execution & Workflow Engine (`core/`, `workflows/`)**: `taskRunner.ts`, `agentLoop.ts`, `WorkflowService`, `GraphExecutor`, `LeafRunner`, YAML DSL parser (`workflowDslParser.ts`), and sub-workflow compiler (`subworkflowCompiler.ts`).
- **Dual-Tier Persistence (`db/`, `artifacts/`)**: SQLite via `better-sqlite3` + `drizzle-orm`, and content-addressed disk artifacts (`.forge/artifacts/<runId>/`) via `ArtifactService`.
- **Evidence, Workspace & Sync (`evidence/`, `git/`, `workspace/`, `benchmark/`, `sync/`)**: Physical git diff reconciliation, child-process verification runner, adversarial verifier, multi-agent worktree isolation, policy-governed concurrency, multi-repo coordination, empirical benchmarks, and cloud replication backplane.

### 3. Agent Runtimes & PTY Hosting (`packages/forge-runtimes`)
Universal `IAgentRuntime` contracts, native in-process LLM agent loop, and interactive ConPTY / POSIX PTY hosting (`ProcessManager`) for Claude Code, Antigravity, OpenCode, and configurable external CLI adapters.

### 4. Standalone CLI (`packages/forge-cli`, `bin/forge.ts`)
Scriptable CLI dispatching `run`, `status`, `models`, `workflows`, `diff`, `db`, `config`, `context`, `benchmark`, `worktree`, `sync`, and `tui` (`CLI-004`) with NDJSON streaming and deterministic exit codes (`0`/`1`/`2`).

### 5. Electron Workstation Shell (`packages/forge-desktop`)
Electron main process entrypoint (`src/main/`), context-isolated preload bridge (`src/preload/`), and React 19 UI (`src/renderer/`) including visual terminal panes, real-time diff inspection, and the drag-and-drop workflow canvas (`UI-001`).

---

## 4. Layering & Dependency Direction

Forge enforces strict unidirectional dependency rules via ESLint boundaries and `npm run check:cycles`:

```
packages/forge-shared/     Pure types, domain schemas, validation, transitions
         ▲                 (NO Node.js, NO Electron, NO React imports)
         │
packages/forge-runtimes/   Agent contracts, runtime adapters, PTY hosting
         ▲
         │
packages/forge-core/       SQLite stores, core kernel, GraphExecutor, verifiers
         ▲
         │
┌────────┴────────────────────────────┐
│                                     │
packages/forge-cli/           packages/forge-desktop/
bin/forge.ts (CLI + TUI)      src/main/ + src/preload/ + src/renderer/ (React 19)
```

1. `@forge/shared` is imported by all packages and remains 100% platform-agnostic.
2. `@forge/core` cannot import Electron or React code.
3. `@forge/desktop`'s renderer cannot import Node.js built-ins or Electron internals; it communicates strictly across the typed preload bridge.

---

## 5. Process & Threading Model

1. **Main Process / CLI Host (Node.js)**: Runs the Electron main loop or standalone `@forge/cli`. Owns filesystem access, git child processes, SQLite databases, and child process management.
2. **Renderer Process (Chromium)**: Sandboxed React UI with `contextIsolation: true` and no native access.
3. **Agent Child Processes**: Spawned via `packages/forge-runtimes/src/process/processManager.ts` using `node-pty` (ConPTY on Windows) or piped stdio, with process-tree cleanup and secret redaction.
4. **Verification Child Processes**: Short-lived processes spawned by `@forge/core` to execute build commands, test suites, or git diffs with strict timeouts.

# System Architecture Overview

**Status:** IMPLEMENTED  
**Authority:** Canonical System Architecture  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  
**Related Decisions:** [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md), [ADR-002](../decisions/ADR-002-interactive-orchestration.md), [ADR-003](../decisions/ADR-003-host-the-real-cli.md)  
**Related Implementation:** `src/main/core/forgeCore.ts`, `src/main/cli.ts`, `src/main/index.ts`  

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
│   │ Standalone CLI (forge)    │      │ Electron Desktop Shell      │   │
│   │ bin/forge.ts              │      │ src/renderer/ (React + UI)  │   │
│   │ NDJSON event stream       │      │ ContextBridge Preload       │   │
│   └─────────────┬─────────────┘      └──────────────┬──────────────┘   │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │                                   │
                  ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        HEADLESS CORE KERNEL                            │
│                        createForgeCore(...)                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Core Orchestration & Task Execution                            │   │
│   │ src/main/core/taskRunner.ts (executeDirectTask)                │   │
│   │ src/main/runtimes/orchestrator.ts                              │   │
│   └──────┬──────────────────────┬──────────────────────┬───────────┘   │
│          │                      │                      │               │
│          ▼                      ▼                      ▼               │
│   ┌──────────────┐       ┌──────────────┐       ┌──────────────┐       │
│   │ Evidence &   │       │ Dual-Tier    │       │ Runtime      │       │
│   │ Verification │       │ Persistence  │       │ Host         │       │
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
| **Execution** | Manages child process trees, timeouts, crash recovery, and terminal PTY multiplexing. | Executes assigned instructions within assigned constraints. |

---

## 3. Major System Subsystems

### 1. Headless Forge Core (`src/main/core/`)
The foundational execution engine (`createForgeCore`), completely decoupled from Electron (achieved in PR #198). It initializes SQLite database connections, registers stores, boots the `GitService`, and manages task execution loops (`taskRunner.ts`). Both the CLI and Electron desktop app consume this same core kernel.

### 2. Dual-Tier Persistence (`src/main/db/` & `src/main/artifacts/`)
- **Relational / Indexed Metadata**: Handled by SQLite via `better-sqlite3` and `drizzle-orm`. Tables manage runs, workflow steps, event logs, and artifact metadata.
- **Content-Addressed Blobs**: Handled by `ArtifactService` on the local filesystem (`.forge/artifacts/<runId>/`). Stores raw stdout/stderr streams, prompt packets, patches, and diff files with SHA-256 integrity verification.

### 3. Evidence & Verification (`src/main/evidence/` & `src/main/git/`)
The physical verification subsystem. Directly executes `git diff` against the base SHA to catch untracked, modified, or out-of-scope files. Executes build and test runners independently of the agent to establish objective verdicts.

### 4. Agent Runtime Abstraction (`src/main/runtimes/` & `src/main/providers/`)
All agent interactions are modeled behind `IAgentRuntime`. 
- **Native Agent Loop**: In-process autonomous loop executing the tools defined in `src/main/providers/tools.ts` (`read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`) against a configured provider model.
- **External CLI Adapters**: Spawns real CLI tools (Claude Code, Antigravity, OpenCode) inside real terminal pseudo-terminals (`node-pty`; ConPTY on Windows).

### 5. Client Interfaces
- **Headless CLI (`bin/forge.ts`, `src/main/cli.ts`)**: Fast, scriptable entrypoint with `--json` streaming NDJSON events and exit codes 0/1/2.
- **Electron Shell (`src/main/`, `src/preload/`, `src/renderer/`)**: Desktop application providing visual terminal panes, real-time diff inspections, decision locking cards, and question queues.

---

## 4. Layering & Dependency Direction

Forge enforces strict unidirectional dependency rules, enforced by automated architecture tests and ESLint boundaries:

```
src/shared/               Pure types, domain schemas, validation, transitions
     ▲                    (NO Node.js, NO Electron, NO React imports)
     │
src/main/db/              SQLite schemas, migrations, repositories
     ▲
     │
src/main/core/            Headless Forge Core kernel & TaskRunner
     ▲
     │
src/main/runtimes/        Agent adapters, tool implementations, PTY hosting
     ▲
     │
┌────┴──────────────────────────┐
│                               │
bin/forge.ts (CLI)      src/main/index.ts (Electron Main)
                                │
                        src/preload/index.ts (Typed ContextBridge)
                                │
                        src/renderer/ (React 19, UI primitives)
```

1. `src/shared` is imported by all layers. It must remain 100% pure TypeScript with zero platform dependencies.
2. `src/main/core` cannot import Electron or Renderer code.
3. `src/renderer` cannot import Node.js built-ins (`fs`, `child_process`) or Electron internals; it communicates strictly across the typed IPC boundary via `src/preload`.

---

## 5. Process & Threading Model

Forge operates across distinct operating system processes:

1. **Main Process (Node.js)**: Runs the Electron main loop or standalone CLI. Owns filesystem access, git child processes, SQLite databases, and child process management.
2. **Renderer Process (Chromium)**: Sandboxed browser window running the React UI. Sandboxed with context isolation enabled; no native access.
3. **Agent Child Processes**: Spawned via `src/main/process/processManager.ts` using `node-pty` (ConPTY on Windows) or piped stdio. Isolated in their own process trees with aggressive cleanup on cancellation or exit.
4. **Verification Child Processes**: Short-lived processes spawned to execute build commands, test suites, or git diffs with strict timeouts and secret redaction.

# ADR-008 — Modular Monorepo Workspace Architecture

**Status:** IMPLEMENTED  
**Authority:** Canonical Repository Packaging Architecture  
**Date:** 2026-11-23  
**Target:** Entire Codebase (`packages/`)  
**Related Decisions:** [ADR-001](ADR-001-agents-runtimes-accounts.md), [ADR-003](ADR-003-host-the-real-cli.md), [ADR-004](ADR-004-architectural-layering-and-boundaries.md), [ADR-007](ADR-007-generic-workflow-graph-engine.md)  
**Related Milestones:** Milestone M16 ([#449](https://github.com/mdsaif45/forge-orchestrator/issues/449), PRs #456–#467)

---

## Context

Forge was initially structured as a single-package Electron application with internal directories (`src/main`, `src/renderer`, `src/preload`, `src/shared`). As Forge matured into an enterprise-grade AI engineering control plane, several major architectural milestones decoupled the core execution engine from Electron:
1. **Headless Core Decoupling (PR #198):** Decoupled the state machine, task runner, and services into `createForgeCore`, enabling headless binary execution via `bin/forge.ts`.
2. **Layering & Boundary Enforcement ([ADR-004](ADR-004-architectural-layering-and-boundaries.md)):** Established strict unidirectional boundaries between Domain, Views, IPC Transport, Application Services, Execution Loops, and Infrastructure, backed by automated cycle gates (`npm run check:cycles`).
3. **Multi-Cluster Execution Hardening (Milestones M1–M12):** Delivered 120+ modular subsystems across Core, Workflows, Evidence, State/DB, and Configuration with 2,700 automated tests.

In ADR-004, package extraction (`forge-core`, `forge-cli`, `forge-desktop`) was deferred until logical boundaries and circular dependencies were eliminated. Because circular dependencies across all 404 source files are now strictly zero and the headless engine is completely operational, the repository is ready to transition to an explicit, modular monorepo workspace.

---

## Decision

Forge adopts an **npm/pnpm workspace monorepo architecture** under `packages/` divided into five canonical packages:

### 1. Package Taxonomy

| Package Name | Physical Location | Platform Dependencies | Responsibilities |
|:---|:---|:---|:---|
| **`@forge/shared`** | `packages/forge-shared` | **Zero** (Pure TypeScript) | Domain models, Zod validation schemas, FSM state machines, View DTOs, and typed IPC request/response contracts. |
| **`@forge/core`** | `packages/forge-core` | Node.js, SQLite (`better-sqlite3`, `drizzle-orm`) | Headless control plane kernel (`createForgeCore`), native agent loop, sandboxed tool execution, generic DAG workflow engine, physical git diff reconciliation, SQLite WAL persistence, and policy gates. |
| **`@forge/runtimes`**| `packages/forge-runtimes`| Node.js, `node-pty` | Universal `IAgentRuntime` contracts, ConPTY / POSIX PTY process tree lifecycle management, runtime registries, and external CLI adapters (Claude, Antigravity, OpenCode, Custom CLIs). |
| **`@forge/cli`** | `packages/forge-cli` | Node.js | Standalone command-line interface binary (`bin/forge.ts`), subcommands dispatcher (`run`, `workflows`, `diff`, `db`, `config`, `context`), NDJSON event streaming, and terminal diff TUI (`CLI-004`). |
| **`@forge/desktop`** | `packages/forge-desktop` | Electron, React 19, DOM | Electron application shell, window management, contextBridge preload security bridge, and React 19 developer workstation UI. |

---

## 2. Dependency Direction & Invariant Rules

Architecture is strictly governed by a Directed Acyclic Graph (DAG):

```
         @forge/shared (Pure Domain & Views)
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
    @forge/core         @forge/runtimes
         │                   │
         ├─────────┬─────────┤
         ▼         ▼         ▼
    @forge/cli @forge/desktop (Custom Consumers)
```

1. **Rule 1 (Purity of `@forge/shared`):** `@forge/shared` MUST NOT depend on any internal workspace packages and MUST NOT import Node.js built-ins (`fs`, `path`, `child_process`, `crypto`), Electron, or DOM APIs.
2. **Rule 2 (Headless Core Isolation):** `@forge/core` depends on `@forge/shared` and `@forge/runtimes`. It MUST NOT import Electron or React packages.
3. **Rule 3 (Universal Runtime Abstraction):** `@forge/runtimes` depends on `@forge/shared`. Runtimes MUST interact with consumers exclusively through `IAgentRuntime`.
4. **Rule 4 (Desktop Encapsulation):** Only `@forge/desktop` may depend on `electron`, `@electron-toolkit/*`, and `@vitejs/plugin-react`.
5. **Rule 5 (Zero Circular Dependencies):** Circular imports across package boundaries or within package boundaries are strictly prohibited and enforced mechanically by `npm run check:cycles`.

---

## 3. Migration Strategy (Strangler Fig Pattern)

To avoid breaking active CI and developer workflows:
- **Phase 1 (Infrastructure):** Define root workspaces, `pnpm-workspace.yaml`, and `@forge/*` path aliases.
- **Phase 2 (Shared Extraction):** Extract pure domain and view schemas into `packages/forge-shared` while maintaining backward-compatible `@shared` aliases.
- **Phase 3 (Runtimes Extraction):** Extract process managers and runtime adapters into `packages/forge-runtimes`.
- **Phase 4 (Core Engine Extraction):** Extract task runner, DAG engine, and state persistence into `packages/forge-core`.
- **Phase 5 (CLI Extraction):** Extract standalone CLI binary and subcommands into `packages/forge-cli`.
- **Phase 6 (Desktop Packaging):** Encapsulate Electron main, preload, and React 19 renderer in `packages/forge-desktop`.

---

## 4. Consequences

### Positive
- Subsystems can be published, installed, and tested independently (`npm install -g @forge/cli`).
- The headless core can be embedded into serverless runners, CLI daemons, or custom developer tools without bundling Electron.
- Eliminates any risk of Electron main/renderer code leaking into the headless execution engine.

### Non-Goals
- We do not replace the existing verified domain schemas or state machine FSM.
- We do not break the 2,700 verified unit, integration, or router test suites.

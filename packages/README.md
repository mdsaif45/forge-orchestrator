# Forge Monorepo Packages

This directory contains the modular workspace packages for Forge:

- **`@forge/shared`** (`packages/forge-shared`): Pure domain entities, Zod validation schemas, FSM transition matrices, read-model View DTOs, and typed IPC channel contracts. Has zero platform built-in imports (`fs`, `path`, `child_process`, `electron`).
- **`@forge/core`** (`packages/forge-core`): Headless control plane kernel, native agent task loop, tool execution suite, DAG workflow graph engine, physical diff reconciliation, SQLite Drizzle schema & WAL state persistence, and security compliance matrices.
- **`@forge/runtimes`** (`packages/forge-runtimes`): Universal `IAgentRuntime` contracts, ConPTY / POSIX PTY process tree lifecycle management, and external CLI adapters (Claude, Antigravity, OpenCode, Custom CLIs).
- **`@forge/cli`** (`packages/forge-cli`): Standalone global command-line interface binary, subcommands dispatcher, NDJSON event streaming mode, and interactive terminal diff TUI (`CLI-004`).
- **`@forge/desktop`** (`packages/forge-desktop`): Electron application shell, contextBridge preload bridge, React 19 UI design system, Monaco code editor, and visual workflow DAG canvas (`UI-001`).

## Dependency Invariant (Strict DAG)

Architecture in Forge is strictly unidirectional:
```
  @forge/shared
        │
   ┌────┴──────────────────────────┐
   ▼                               ▼
@forge/core                 @forge/runtimes
   │                               │
   ├──────────────┬────────────────┤
   ▼              ▼                ▼
@forge/cli   @forge/desktop   (Custom Apps)
```
Circular dependencies across or within packages are strictly forbidden and guarded by `npm run check:cycles`.

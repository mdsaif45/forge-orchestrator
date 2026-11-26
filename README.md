# Forge

**An AI engineering control plane.**

Multiple coding agents collaborate on the same software project under a shared
execution protocol — planning, implementing, verifying, and reviewing.
The user stays in the loop as the decision maker; they just stop being the transport.

---

## The problem

Today, orchestrating two coding agents means *you* are the transport layer:

```
YOU ──> plan with agent A ──> copy prompt ──> agent B implements
 ▲                                                    │
 └──── copy response ──── review with agent A ────────┘
                    repeat until it is right
```

Every hop is a manual copy-paste, and context is lost at every boundary.

## What Forge does

```
                        ┌──────────────┐
                        │     YOU      │
                        │  decisions   │
                        └──────┬───────┘
                               │  goals · approvals · answers
                        ┌──────▼───────┐
                        │    FORGE     │  ← owns the truth
                        │ orchestrator │
                        └──────┬───────┘
              ┌────────────────┼────────────────┐
         ┌────▼────┐      ┌────▼────┐      ┌────▼────┐
         │ PLANNER │      │ BUILDER │      │REVIEWER │
         └────┬────┘      └────┬────┘      └────┬────┘
              └────────────────┼────────────────┘
                        ┌──────▼───────┐
                        │ PROJECT STATE│
                        │ git · files  │
                        │ tests · log  │
                        └──────────────┘
```

Roles are bindings, not identities. Any runtime can hold any role.

## The core loop (Workflow Template #001)

The default linear workflow coordinates an end-to-end development cycle, compiled into and executed on the **Generic Workflow Graph Engine** (`GraphExecutor`):

```
DISCOVERY ─> PLANNING ─> PLAN_READY ─(you approve)─> DECISIONS_LOCKED
                                                          │
                                                    IMPLEMENTING
                                                          │
                                                     VERIFYING     ← Forge runs build + tests
                                                          │
                                                     REVIEWING
                                                          │
                                                 ┌────────┴────────┐
                                               PASS              FAIL
                                                 │                 │
                                               DONE    CORRECTION_REQUIRED
                                                                   │
                                                                   └─> IMPLEMENTING

any state ─(agent uncertain)─> AWAITING_USER ─(you answer)─> resume
any state ─(cap reached)─────> HALTED_LIMIT
any state ─(policy violated)─> HALTED_POLICY
```

> **Workflow Architecture:** `WorkflowService` compiles linear workflows, YAML DSL workflows (`COMP-001`), and nested reusable sub-workflow DAG templates (`COMP-002`) into executable graphs on `GraphExecutor` ([ADR-007](docs/decisions/ADR-007-generic-workflow-graph-engine.md)), complete with physical git worktree isolation (`PAR-002`), disjoint fan-in patch materialization, policy-governed concurrency (`PAR-001`), and visual canvas authoring (`UI-001`).

---

## The seven axioms

| # | Axiom | Meaning |
|---|-------|---------|
| A1 | **Forge owns truth** | Agents perform work. Chat history is not state. |
| A2 | **UNKNOWN != ASSUME** | Probe repo, config, history. Still unclear? Ask, then wait. |
| A3 | **Evidence beats claims** | Agent says "tests pass" → Forge runs the tests itself. |
| A4 | **Decisions lock** | A locked decision changes only via a user-approved change request. |
| A5 | **Bounded loops** | Every workflow has iteration caps and explicit terminal states. |
| A6 | **No provider in core** | Core talks to `IAgentRuntime`. Claude and Antigravity are adapters. |
| A7 | **Least privilege** | Permissions enforced by Forge, not requested in a prompt. |

The `A2` escalation ladder, in full:

```
1. inspect repository
2. inspect configuration
3. inspect related implementation
4. inspect project state, decisions, prior tasks
        │
   still ambiguous
        │
5. OPEN QUESTION ──> question queue ──> workflow pauses
```

No agent is ever permitted to write `"I assume..."` and continue.

---

## Architecture

Forge follows a strict unidirectional layered monorepo architecture ([ADR-004](docs/decisions/ADR-004-architectural-layering-and-boundaries.md), [ADR-008](docs/decisions/ADR-008-modular-monorepo-workspace-architecture.md)):

```
┌─────────────────────────── @forge/desktop ────────────────────────┐
│ Electron Main · ContextBridge Preload · React 19 UI · Visual DAG  │
└─────────────────────────── Preload IPC ───────────────────────────┘
        typed · contextIsolation · allowlisted channels · no node
┌─────────────────────────── @forge/cli ────────────────────────────┐
│ Standalone Headless CLI (bin/forge.ts) · NDJSON · Terminal TUI    │
└──────────────────────────────────┬────────────────────────────────┘
┌─────────────────────────── @forge/core ───────────────────────────┐
│ APPLICATION  WorkflowService · ProjectService · ArtifactService   │
│              DecisionService · QuestionService · PolicyEngine     │
│ EXECUTION    GraphExecutor · LeafRunner · TaskRunner · Concurrency│
│              WorktreeService · ChangeSetMerger · Cloud Sync       │
│ INFRA        SQLite + Drizzle (RunStore, EventStore, ArtifactStore│
│              DecisionStore, WorkflowStore) · GitService           │
├─────────────────────────── @forge/runtimes ───────────────────────┤
│ RUNTIMES     IAgentRuntime · NativeAgent · Claude · Antigravity   │
│              Generic CLI · ProcessManager (ConPTY / node-pty)     │
├─────────────────────────── @forge/shared ─────────────────────────┤
│ PURE DOMAIN  Schemas · Transitions · Criteria · View DTOs · IPC   │
└───────────────────────────────────────────────────────────────────┘
```

## Stack

In use today:

```
Electron 43 · electron-vite 5 · Vite 7 · React 19 · TypeScript 5.9 (strict)
Tailwind 4 + @forge/desktop UI primitives · zustand (UI state only) · zod 4
vitest · playwright · eslint 10 · prettier
better-sqlite3 + Drizzle (persistence) · node-pty (ConPTY / agent CLI processes)
npm Workspaces: @forge/shared · @forge/core · @forge/runtimes · @forge/cli · @forge/desktop
```

## Quickstart

```bash
npm ci
npm run setup   # fetches Electron's binary
npm run dev
```

Verify everything the way CI does:

```bash
npm run check
```

```
format:check → lint → typecheck → check:cycles → test → build
            → check:router → check:docs → smoke → check:no-dev-code → check:ui → test:e2e
```

| Command | What it proves |
|---------|----------------|
| `npm run test` | unit & integration suites across `@forge/*` workspaces |
| `npm run check:cycles` | zero circular dependencies across packages and modules |
| `npm run check:router` | IPC boundary rules, without launching Electron |
| `npm run check:docs` | `docs/DOMAIN.md` state diagram matches `transitions.ts` |
| `npm run smoke` | process isolation, CSP, and the preload bridge |
| `npm run check:ui` | computed styles, themes, and routing |
| `npm run test:e2e` | the real Electron app's own startup path |

`.npmrc` sets `ignore-scripts`, because npm otherwise tries to compile
`better-sqlite3` from source — it ships a `binding.gyp`, which npm acts on even
though the package sets `gypfile: false` — and that needs a C++ toolchain nobody
should have to install. Its bundled N-API prebuilds work as they are.

That means the one binary which genuinely needs fetching is Electron's, since
`electron@43` ships no postinstall of its own. If you see
`Error: Electron uninstall`:

```bash
npm run setup
```

`npm rebuild electron` does **not** fetch it.

## Roadmap

| Milestone | Focus & Capabilities | Status |
|-----------|----------------------|--------|
| **M0 Baseline** | Quality gates, CI matrix, Windows git `EBUSY` fix | **DONE** |
| **M1 Headless Core** | `createForgeCore` decoupled from Electron, `--data-dir`, `.forgerc` | **DONE** |
| **M2 Native Agent** | Native in-process tool loop (`taskRunner.ts`), concurrent read-only tools, Ollama probing | **DONE** |
| **M3 Forge CLI** | Standalone CLI, NDJSON streaming, exit codes, interactive TUI (`CLI-004`) | **DONE** |
| **M4 State & Storage** | SQLite `RunStore`/`EventStore`/`ArtifactStore`, `ArtifactService`, typed IPC events | **DONE** |
| **M5 Verification** | Physical diff reconciliation, build/test runner, criteria evaluator, adversarial verifier | **DONE** |
| **M6 Workflow Graph** | `GraphExecutor` DAG engine, branch worktrees, fan-in merge, `WorkflowService` cutover | **DONE** |
| **M7 Human Control** | Blocking approval gate, live PTY steering, xterm process attachment, ADR-005 | **DONE** |
| **M8 Provider Ecosystem** | Data-driven custom CLI adapters, hosted Antigravity ConPTY, quota detection | **DONE** |
| **M9 Warm Sessions** | Resumable `IAgentRuntime` sessions, Claude/Antigravity session resume, benchmark | **DONE** |
| **M10 Interactive Control** | Real blocking approval gate, stage run/skip/rerun, mid-run interjections | **DONE** |
| **M11 Host the Real CLI** | Bidirectional ConPTY session hosting, legacy stdout scraper decommission | **DONE** |
| **M12 Autonomous Control Plane** | Streaming chunks, speculative pruning, reverse patch verification, WAL tooling, `CLI-004` TUI | **DONE** |
| **M13 Empirical Benchmarking** | Reproducible benchmark harness, latency profiler, concurrency endurance suite | **DONE** |
| **M14 Workspace Isolation & Concurrency** | Policy concurrency limiter, multi-agent worktree isolation, quarantine, multi-repo orchestration | **DONE** |
| **M15 Workflow DSL & Cloud Replication** | YAML Workflow DSL, reusable sub-workflows, visual drag-and-drop canvas, cloud state sync | **DONE** |
| **M16 Modular Monorepo Refactoring** | Full ADR-008 migration to `@forge/shared`, `@forge/core`, `@forge/runtimes`, `@forge/cli`, `@forge/desktop` | **DONE** |

Program roadmap and task breakdown are tracked in [`docs/roadmap/milestones.md`](docs/roadmap/milestones.md).

## Status

All planned engineering milestones **M0 through M16** are **complete on `main`** and closed on GitHub (`0` open issues). Forge runs both as a headless CLI/engine (`@forge/cli`, `@forge/core`) and an Electron workstation UI (`@forge/desktop`), executing workflows on `GraphExecutor` with real ConPTY CLI hosting, isolated git worktrees, independent evidence verification, visual DAG authoring, multi-repository orchestration, and content-addressed state replication.

Milestone statuses above summarise [`docs/project/current-state.md`](docs/project/current-state.md),
which is the authoritative record of what is implemented and carries the test evidence for
each capability. If this table and that document ever disagree, that document is correct.

## Documentation

The canonical documentation architecture is indexed in [**`docs/README.md`**](docs/README.md):

| Domain | Canonical Documents |
|--------|---------------------|
| **Master Index** | [`docs/README.md`](docs/README.md) — central documentation catalog |
| **Product Intent** | [`docs/product/vision.md`](docs/product/vision.md) · [`docs/product/north-star.md`](docs/product/north-star.md) · [`docs/product/principles.md`](docs/product/principles.md) |
| **Architecture** | [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) · [`execution-model.md`](docs/architecture/execution-model.md) · [`evidence-and-verification.md`](docs/architecture/evidence-and-verification.md) |
| **Contracts** | [`docs/architecture/contracts/execution-protocol.md`](docs/architecture/contracts/execution-protocol.md) · [`run-and-step-lifecycle.md`](docs/architecture/contracts/run-and-step-lifecycle.md) |
| **Decisions** | [`docs/decisions/README.md`](docs/decisions/README.md) (ADRs 001–008) |
| **Project Truth** | [`docs/project/current-state.md`](docs/project/current-state.md) · [`docs/project/progress.md`](docs/project/progress.md) · [`verification-baseline.md`](docs/project/verification-baseline.md) |
| **Specifications** | [`docs/DOMAIN.md`](docs/DOMAIN.md) (state machine) · [`docs/FORGE_RULES.md`](docs/FORGE_RULES.md) (agent rules R1–R8) |
| **Operations** | [`docs/operations/development.md`](docs/operations/development.md) · [`docs/operations/testing.md`](docs/operations/testing.md) · [`docs/operations/release.md`](docs/operations/release.md) |
| **Contributing** | [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md) |

## Non-goals

custom code editor · third-party plugin marketplace · autonomous self-approval without human gate

## License

MIT

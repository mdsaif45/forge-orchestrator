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

## The core loop

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

```
┌────────────────────── RENDERER (React + TS) ──────────────────────┐
│ ui/primitives   Button Dialog Tabs Badge Status EmptyState …      │
│ ui/domain       AgentCard WorkflowNode DiffViewer QuestionCard    │
│ pages           Dashboard Project Workflow Changes Questions …    │
└─────────────────────────── preload IPC ───────────────────────────┘
        typed · contextIsolation · allowlisted channels · no node
┌─────────────────────────── MAIN (Node) ───────────────────────────┐
│ APPLICATION  WorkflowEngine · AgentOrchestrator · ContextEngine   │
│              DecisionMgr · QuestionMgr · ChangeMgr · PolicyEngine │
├───────────────────────────────────────────────────────────────────┤
│ INFRA        IAgentRuntime adapters · GitService · ProcessManager │
│              SQLite + Drizzle · SecretStore · CommandRunner       │
└───────────────────────────────────────────────────────────────────┘
                                │
                    Claude CLI      Antigravity CLI
                    (spawned pty, existing machine login)
```

## Stack

In use today:

```
Electron 43 · electron-vite 5 · Vite 7 · React 19 · TypeScript 5.9 (strict)
Tailwind 4 + hand-rolled primitives · zustand (UI state only) · zod 4
vitest · playwright · eslint 10 · prettier
```

Planned, per milestone:

```
better-sqlite3 + Drizzle   persistence          M1  (#15)
node-pty                   agent CLI processes  M2  (#23)
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
format:check → lint → typecheck → test → build
            → check:router → smoke → check:ui → test:e2e
```

| Command | What it proves |
|---------|----------------|
| `npm run test` | logic and primitives, in Node and jsdom |
| `npm run check:router` | IPC boundary rules, without launching Electron |
| `npm run smoke` | process isolation, CSP, and the preload bridge |
| `npm run check:ui` | computed styles, themes, and routing |
| `npm run test:e2e` | the real app's own startup path |

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
| **M0 Baseline** | Quality gates, CI matrix, process boundaries | **DONE** |
| **M1 Headless Core** | `createForgeCore` decoupled from Electron, custom `--data-dir` | **DONE** |
| **M2 Native Agent** | Native in-process tool loop (`taskRunner.ts`), LLM chat bindings | **DONE** |
| **M3 Forge CLI** | Standalone `forge run` CLI, NDJSON streaming, exit codes | **DONE** |
| **M4 State & Storage** | SQLite `RunStore`/`EventStore`, filesystem `ArtifactService` | **DONE** |
| **M5 Verification** | Physical diff reconciliation, 7-criteria evaluator engine | **IN PROGRESS** (PR #204) |
| **M6 Workflow Graph** | Generic DAG execution engine, modular visual nodes | **READY** |
| **M7 Human Control** | Live terminal PTY steering, interactive mid-flight interjection | **BLOCKED** |
| **M8 Provider Ecosystem** | Extensible external CLI adapter catalog (Claude, Antigravity) | **READY** |
| **M9 Polish & Scale** | Multi-repository orchestration, production distribution | **DEFERRED** |

Program roadmap and task breakdown are tracked in [`docs/roadmap/milestones.md`](docs/roadmap/milestones.md).

## Status

Forge has completed its headless core transition. Headless Core (`createForgeCore`), Native Agent execution (`taskRunner.ts`), standalone CLI (`forge run`), and dual-tier SQLite persistence (`RunStore`, `ArtifactStore`, `EventStore`, `ArtifactService`) are merged into `main` and verified across 1,125 tests.

Active development is in Phase 2: Observability & Criteria Verification (PR #204).

## Documentation

The canonical documentation architecture is indexed in [**`docs/README.md`**](docs/README.md):

| Domain | Canonical Documents |
|--------|---------------------|
| **Master Index** | [`docs/README.md`](docs/README.md) — central documentation catalog |
| **Product Intent** | [`docs/product/vision.md`](docs/product/vision.md) · [`docs/product/north-star.md`](docs/product/north-star.md) · [`docs/product/principles.md`](docs/product/principles.md) |
| **Architecture** | [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) · [`execution-model.md`](docs/architecture/execution-model.md) · [`evidence-and-verification.md`](docs/architecture/evidence-and-verification.md) |
| **Contracts** | [`docs/architecture/contracts/execution-protocol.md`](docs/architecture/contracts/execution-protocol.md) · [`run-and-step-lifecycle.md`](docs/architecture/contracts/run-and-step-lifecycle.md) |
| **Decisions** | [`docs/decisions/README.md`](docs/decisions/README.md) (ADRs 001–003) |
| **Project Truth** | [`docs/project/current-state.md`](docs/project/current-state.md) · [`docs/project/progress.md`](docs/project/progress.md) · [`verification-baseline.md`](docs/project/verification-baseline.md) |
| **Specifications** | [`docs/DOMAIN.md`](docs/DOMAIN.md) (state machine) · [`docs/FORGE_RULES.md`](docs/FORGE_RULES.md) (agent rules R1–R8) |
| **Operations** | [`docs/operations/development.md`](docs/operations/development.md) · [`docs/operations/testing.md`](docs/operations/testing.md) · [`docs/operations/release.md`](docs/operations/release.md) |
| **Contributing** | [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md) |

## Non-goals (for the MVP)

custom code editor · plugin marketplace · cloud sync · team collaboration
visual workflow designer · agent memory system · unbounded agent concurrency

## License

MIT

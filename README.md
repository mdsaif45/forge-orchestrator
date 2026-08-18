# Forge

**An AI engineering control plane.**

Multiple coding agents collaborate on the same software project under a shared
execution protocol — planning, implementing, verifying, and reviewing — while you
stay out of the message bus.

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
npm install     # also fetches Electron's binary; see the note below
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

If you see `Error: Electron uninstall`, the binary is missing —
`electron@43` ships no postinstall of its own, so this project declares one:

```bash
npm run postinstall
```

`npm rebuild electron` does **not** fetch it.

## Roadmap

| Milestone | Proves |
|-----------|--------|
| **M0** Foundation | app boots, hardened IPC, CI green, design system seeded |
| **M1** State Core | project + repo + SQLite + event log + git service |
| **M2** Runtime Adapters | `IAgentRuntime`, mock runtime, real CLI adapters |
| **M3** Workflow Engine | state machine, checkpoints, resume, loop guards, context engine |
| **M4** Evidence & Review | build/test runners, diff scope, computed verdicts |
| **M5** Human Control Plane | question queue, decision lock, changes UI — **MVP** |
| **M6** Polish & Scale | multi-account, templates, settings UI, packaging |

MVP = M0 → M5. Progress is tracked in
[issues](https://github.com/mdsaif45/forge-orchestrator/issues) and
[milestones](https://github.com/mdsaif45/forge-orchestrator/milestones).

## Status

Pre-alpha, in **M0**. The app boots with a hardened process boundary, a reusable
design system, a routed shell, and a verification gate wired into CI on Linux and
Windows. No agent orchestration exists yet — that begins at M2.

## Documentation

| Document | Contents |
|----------|----------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | processes, IPC contract, security posture, verification layers |
| [`docs/DOMAIN.md`](docs/DOMAIN.md) | entities and the workflow state machine (specification) |
| [`docs/PLAN.md`](docs/PLAN.md) | milestones, and the toolchain traps found along the way |
| [`docs/FORGE_RULES.md`](docs/FORGE_RULES.md) | the policy set Forge enforces on its agents |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | branch flow and the lint-enforced boundaries |
| [`CLAUDE.md`](CLAUDE.md) | conventions for coding agents working on Forge |

## Non-goals (for the MVP)

custom code editor · plugin marketplace · cloud sync · team collaboration
visual workflow designer · agent memory system · unbounded agent concurrency

## License

MIT

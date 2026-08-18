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

```
Electron  ·  electron-vite  ·  React + TypeScript (strict)
Tailwind + hand-rolled primitives  ·  zustand (UI state only)
better-sqlite3 + Drizzle  ·  node-pty  ·  zod  ·  vitest + playwright
```

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

Pre-alpha. Planning and issue breakdown complete; implementation starts at M0.

See [`docs/PLAN.md`](docs/PLAN.md) for the full build plan.

## Non-goals (for the MVP)

custom code editor · plugin marketplace · cloud sync · team collaboration
visual workflow designer · agent memory system · unbounded agent concurrency

## License

MIT

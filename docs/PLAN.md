# Forge — Build Plan

> **AI Engineering Control Plane.** Multiple coding agents collaborate on one repo
> under a shared execution protocol. Forge owns state; agents are replaceable workers.

## Axioms (never violate)

```
A1  FORGE owns truth.  Agents perform work.  Chat != state.
A2  UNKNOWN != ASSUME.  probe repo -> probe config -> probe history
                        -> still unclear -> OPEN QUESTION -> WAIT for user
A3  Evidence > claims.  agent says "tests pass" -> Forge runs tests
                        agent says "3 files"    -> Forge runs git diff
A4  Decisions LOCK.     locked decision changes only via user-approved CR
A5  Bounded loops.      every workflow has max iterations + explicit terminal states
A6  No provider in core. core talks IAgentRuntime only; Claude/AG are adapters
A7  Least privilege.    per-role permissions enforced by Forge, not by prompt
```

## Domain model

```
Workspace
 └── Project ──── Repository (path, branch, build cmd, test cmd)
      ├── Rules            (inherited: global -> project -> workflow -> agent -> task)
      ├── AgentBinding     (role -> runtime + account + permissions)
      ├── Decision         (id, statement, rationale, status: proposed|approved|LOCKED)
      ├── OpenQuestion     (id, asker, evidence[], options[], recommendation, answer)
      ├── Workflow         (template, state, iteration, checkpoint)
      │    └── Step        (role, agent, input ctx, output, verdict)
      ├── Task             (objective, constraints, completion criteria)
      ├── ChangeSet        (git diff snapshot, author agent, review verdict)
      └── EventLog         (append-only, replayable)
```

## Workflow state machine

```
                    DISCOVERY
                        |
                    PLANNING
                        |
                    PLAN_READY ──(user approve)──> DECISIONS_LOCKED
                        |                                |
                        |                          IMPLEMENTING
                        |                                |
                        |                          VERIFYING  (build+test+diff scope)
                        |                                |
                        |                           REVIEWING
                        |                                |
                        |                          ┌─────┴─────┐
                        |                        PASS        FAIL
                        |                          |           |
                        |                        DONE    CORRECTION_REQUIRED
                        |                                      |
                        |                                      └──> IMPLEMENTING
                        |                                           (iteration++)
                        |
   any state ──(agent uncertain)──> AWAITING_USER ──(answer)──> resume prior state
   any state ──(limit hit)────────> HALTED_LIMIT
   any state ──(policy violation)─> HALTED_POLICY
```

## Layered architecture

```
┌───────────────────────── RENDERER (React) ─────────────────────────┐
│  ui/primitives  (Button Dialog Tabs Badge Status EmptyState ...)   │
│  ui/domain      (AgentCard WorkflowNode DiffViewer QuestionCard)   │
│  pages          (Dashboard Project Workflow Changes Questions Set) │
└──────────────────────────── preload IPC ───────────────────────────┘
                     typed, contextIsolation, no node in renderer
┌────────────────────────── MAIN (Node) ─────────────────────────────┐
│ APPLICATION   WorkflowEngine  AgentOrchestrator  ContextEngine     │
│               DecisionMgr  QuestionMgr  ChangeMgr  PolicyEngine    │
├────────────────────────────────────────────────────────────────────┤
│ INFRA         IAgentRuntime adapters | GitService | FsService      │
│               ProcessManager(pty) | SQLite+Drizzle | SecretStore   │
└────────────────────────────────────────────────────────────────────┘
                                  |
                     Claude CLI        Antigravity CLI
                     (spawned pty, Pro login on machine)
```

## Context Engine (the differentiator)

```
project state + current task + relevant decisions + relevant files
+ prior attempt + review findings + rules + open answers
                        |
                  CONTEXT ENGINE   (select, rank, budget, redact secrets)
                        |
             agent-specific prompt packet  (deterministic, snapshotted per step)
```

Never dump full history. Never include `.env`. Snapshot every packet for replay.

## Milestones

| M  | Name                  | Proves                                              |
|----|-----------------------|-----------------------------------------------------|
| M0 | Foundation            | app boots, IPC safe, CI green, design system seeded |
| M1 | State core            | project + repo + SQLite + event log + git service   |
| M2 | Runtime adapters      | spawn CLI, structured protocol, mock runtime, cancel|
| M3 | Workflow engine       | full state machine, checkpoints, resume, limits     |
| M4 | Evidence + review     | build/test runners, diff scope check, verdicts      |
| M5 | Human control plane   | question queue, decision lock, changes UI, edit mode|
| M6 | Polish & scale        | multi-account, templates, permissions UI, packaging |

MVP = M0..M5. One project, one loop, no manual copy-paste.

## Phases inside milestones

```
P1 scaffold   P2 domain+persistence   P3 runtime   P4 engine
P5 evidence   P6 human control        P7 hardening
```

## Toolchain (pinned, verified together)

```
electron-vite 5.0  ─┐
vite          7.3  ─┼─ peer ranges overlap; plugin-react 6 requires vite 8
plugin-react  5.2  ─┘  and does NOT work with electron-vite 5
electron      43.4
typescript    5.9   (not 7.x — unverified against this toolchain)
react/dom     19.2
zod           4.4
```

Two setup gotchas, both hit during M0:

```
1. preload cannot be ESM when sandbox:true
   -> emit cjs, entryFileNames '[name].cjs', main must load .cjs
2. `npm install` may skip electron's postinstall (no dist/, no path.txt)
   -> "Electron uninstall" at launch; fix: node node_modules/electron/install.js
```

## Out of scope for MVP

custom code editor · plugin marketplace · cloud sync · team collab
workflow visual designer · agent memory system · >2 concurrent agents

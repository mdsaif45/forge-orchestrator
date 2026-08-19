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
|    |                       | ⚠ reshaped by the #20 spike — see below             |
| M3 | Workflow engine       | full state machine, checkpoints, resume, limits     |
| M4 | Evidence + review     | build/test runners, diff scope check, verdicts      |
| M5 | Human control plane   | question queue, decision lock, changes UI, edit mode|
| M6 | Polish & scale        | multi-account, templates, permissions UI, packaging |

MVP = M0..M5. One project, one loop, no manual copy-paste.

## Execution order

Milestones say *what each layer proves*; this says *what order the remaining work
runs in*, and why a blocked M2 does not stall the MVP.

```
PHASE A  Evidence          M4   #33 -> #35 -> #36 -> #37
PHASE B  Workflow UI       M3   #32                       (after #33)
PHASE C  Human control     M5   #38 #39 #40 #41 #42 -> #43 MVP acceptance
PHASE D  Real runtimes     M2   #62 #63 #64 -> #24 #25    (blocked, see below)
PHASE E  Scale             M6   #44 #45 #46 #47 #48       (post-MVP)
```

Dependency shape — D runs sideways, not in series:

```
A (#33 -> #35 -> #36 -> #37) ──┬──> C (M5) ──> #43 MVP
                               │
B (#32) ───────────────────────┘

D (M2) ── parallel, blocked on user decisions
          MockAgentRuntime carries A, B and C in the meantime;
          a real adapter plugs into the same IAgentRuntime port.
```

That last line is the whole return on A6. Core depends on the port, not on a
provider, so the mock and a real CLI are substitutable — which is why M2 can sit
blocked while the MVP is built. The cost of the abstraction was paid in M2; this
is where it pays back.

## Providers are an open set (decided on #63)

The builder role is **not** assigned to a vendor. It is bound per project:

```
NOT   builder := Antigravity
NOT   builder := Claude
BUT   builder := whichever provider the project binds to that role
```

The intended provider set is open-ended and grows by adapter:

```
claude · antigravity · codex · cursor · aider · opencode · kimi · ...
```

`ClaudeCliRuntime` (#24) is first only because it is the one measured to work
headless — not because Claude is privileged. Each further provider is its own
adapter issue behind the same port, gated on its own capability spike.
Antigravity's missing headless entry point is a capability gap on one provider,
not a reason to collapse the role model onto a single vendor.

## What the #20 spike changed

Measured, not assumed — full evidence in `docs/spikes/agent-cli-capability.md`.

```
Claude Code 2.1.209   -p · --output-format json|stream-json · exit codes   WORKS
Antigravity 1.107     `chat` opens a GUI WINDOW, no stdout, never exits    DOES NOT
```

Antigravity is a VS Code fork shipped as a GUI app, with no headless entry point. So
the MVP loop cannot be two spawned CLIs, and #25 is unbuildable as written (#63).

```
#21 IAgentRuntime      unchanged — A6 is what makes this survivable
#22 MockAgentRuntime   unchanged, now the critical path for M3/M4
#23 ProcessManager     unchanged, target Claude
#24 ClaudeCliRuntime   after the authenticated re-run (#64)
#25 Antigravity        BLOCKED (#63)
```

Two traps worth remembering, both measured:

```
1. json envelope reported subtype:"success" WHILE is_error:true
   => key off is_error and the exit code, never subtype
2. the auth failure was written to STDOUT, not stderr
   => an adapter reading only stderr sees nothing on failure
```

And one constraint that shapes context handling:

```
plain -p   inherits ambient CLAUDE.md · hooks · plugins · MCP
--bare     isolates them, but NEVER reads OAuth (API key only)
           => full isolation and Pro auth are mutually exclusive;
              isolate with --settings/--strict-mcp-config instead
```

Open decisions: #62 (ToS + rate limits), #63 (builder role), #64 (authenticated re-run).

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

Three gotchas, all hit and measured:

```
1. preload cannot be ESM when sandbox:true
   -> emit cjs, entryFileNames '[name].cjs', main must load .cjs
2. native binaries: three packages, three different mechanisms
   electron@43      ships NO postinstall -> binary must be fetched explicitly
                    (`npm rebuild electron` does NOT do it)
   better-sqlite3   ships binding.gyp -> npm runs node-gyp even though the
                    package sets gypfile:false. needs a C++ toolchain and fails
                    on Windows CI. but prebuilds/win32-x64.node ships and WORKS,
                    so the compile is pure waste.
   esbuild          platform binary is an optional dep. nothing to do.
   node-pty       ships prebuilds for darwin-arm64/x64 and win32-arm64/x64 --
                    but NOT linux-x64. loads untouched on Windows and macOS;
                    must be compiled on Linux. CI caught this: Windows passed
                    while Linux failed with
                      Cannot find module './prebuilds/linux-x64//pty.node'
                    the fourth mechanism, and the only PARTIALLY painless one.
   fix: .npmrc ignore-scripts + `npm run setup` (electron, and node-pty where
        no prebuild exists). `npm run setup:pty` is the pty alone, for the CI job
        that runs tests but never launches the app.
   NOTE: an existing node_modules hides all of this. it only appears on a clean
   install — which is why "no rebuild needed" survived a PR review before CI
   caught it.
3. contextBridge serializes errors STRUCTURALLY
   measured across the bridge:
     throw Error + own prop  -> prop STRIPPED, name reset to "Error"
     throw plain object      -> survives
     RETURN result envelope  -> survives          <- chosen
   => preload returns IpcResult; renderer unwraps and throws locally.
      A custom Error subclass thrown from preload silently loses .code.
```

## Out of scope for MVP

custom code editor · plugin marketplace · cloud sync · team collab
workflow visual designer · agent memory system · >2 concurrent agents

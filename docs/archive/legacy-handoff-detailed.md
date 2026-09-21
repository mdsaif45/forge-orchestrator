# Forge — Full Project Handoff Document

Generated for a coding agent that will refactor this project. Covers: the full
architectural history (what was tried, what was wrong, what changed and why),
the current state (done / not done / stub / dead code), and a file-by-file
inventory of every source file in `src/`.

**One constraint that must be honored in everything derived from this
document**: never name the external reference orchestrator this project's
architecture was compared against, in any commit, issue, PR, or other
artifact. Describe it only in the generic terms already used here and in
`docs/NORTH-STAR.md` / `docs/decisions/ADR-003-host-the-real-cli.md`.

## Table of contents

1. **History, architecture pivot, current state** — what Forge is, the seven
   axioms, the full milestone history (M0–M11), the M8 mistake and the M11
   inversion that fixed it, every concrete bug found and fixed along the way,
   precisely what is done vs. not-done vs. stub in M11 right now, and where
   the permanent project docs live.
2. **`src/main/db/`, `src/main/runtimes/`, `src/main/git/`** — the event
   store and projections, every runtime adapter (mock/Claude
   headless/Claude hosted/Antigravity), the hosted-CLI hook/paste-delivery
   mechanism, and git/worktree isolation.
3. **Remaining `src/main/`** (bootstrap, IPC, accounts, audit, bindings,
   changesets, context, decisions, evidence, health, logging, process,
   projects, questions, terminal, workflows) **+ `src/preload/`** — the
   Electron main-process entry point and every application service, plus a
   cross-cutting list of dead code and stub logic found during this pass.
4. **`src/shared/`** — the domain layer (zod schemas, pure functions, the
   workflow state machine, the IPC contract) that both main and renderer
   compile against.
5. **`src/renderer/`** — every page, store, and UI primitive in the React
   frontend, including a confirmed list of dead/unused components.

---
# Forge — Handoff Document, Part 1: History, Architecture Pivot, Current State

This document is written for a coding agent that will refactor this project. It
assumes no memory of any prior session. Read this part first for the "why" behind
the codebase; the per-file parts that follow describe the "what."

---

## 1. What Forge is

Forge is an Electron desktop app that orchestrates multiple coding-agent CLIs
(Claude Code, an "Antigravity" CLI referred to as `agy`, and originally intended
to support others like OpenCode) against a real git repository, under a shared
workflow protocol Forge itself defines and enforces. It is not a chat UI wrapper —
it owns a durable event-sourced state model, runs agents in isolated git
worktrees, verifies their claims against the actual repository (build/test/diff),
and gates permission and scope per role.

Seven axioms it holds itself to (referenced throughout the codebase as A1-A7):

```
A1  Forge owns truth        the event log + projections are the record, not chat
                            history; agents emit events, never write state directly
A2  Never guess             ambiguity -> ask, don't pick a plausible default
A3  Evidence over claims    an agent's self-report is not trusted; Forge runs the
                            build/tests/diff itself and verifies
A4  Decisions lock          an approved decision changes only by an approved request
A5  Bounded loops           iteration caps, timeouts, terminal states — always
A6  No provider in core     core code only sees IAgentRuntime; CLI-specific
                            argv/parsing/quirks live in adapter files
A7  Least privilege         Forge enforces the permission a role gets; the CLI's
                            own prompt is not the enforcement mechanism
```

These are not aspirational — they show up as literal lint-enforced import
boundaries (renderer cannot import `electron`/`node:*`; shared cannot import
`electron`/`react`), as a real transition-table state machine that throws on an
illegal transition, and as a policy layer that computes a role's permission mode
rather than trusting what an agent's CLI flag claims.

---

## 2. The milestone history (what was built, in order)

Read top to bottom — this is the actual build order, all in GitHub issues/milestones:

```
M0  Foundation              hardened Electron shell: contextIsolation, typed IPC
                            via zod, design tokens + primitives, app shell/routing,
                            CI (lint/typecheck/vitest/playwright), docs baseline
                            — CLOSED, fully built

M1  State Core              domain model as zod schemas + branded types, SQLite +
                            Drizzle with migrations, append-only event log +
                            projections, GitService (read-only), project
                            creation/binding, rules engine with scope inheritance
                            — CLOSED, fully built

M2  Runtime Adapters        IAgentRuntime abstraction + registry, MockAgentRuntime
                            with scripted scenarios, ProcessManager (pty spawn,
                            streaming, timeouts, cancel, zombie reaping),
                            ClaudeCliRuntime, AntigravityCliRuntime, the
                            PromptPacket/AgentReport protocol
                            — CLOSED (one item, #64, still open: re-running an
                              authenticated spike)

M3  Workflow Engine         workflow state machine as an explicit transition
                            table, checkpointing + crash resume, loop guards,
                            Context Engine (minimal sufficient context,
                            snapshotted + redacted), the orchestrator (role
                            bindings, capability checks), the workflow UI (graph,
                            live log, step inspector)
                            — CLOSED, fully built

M4  Evidence and Review     build/test runners producing evidence artifacts, diff
                            reconciliation + scope enforcement, completion
                            criteria evaluator, review + correction loop, policy
                            engine (per-role permissions, dangerous commands,
                            secret exclusion)
                            — CLOSED, fully built

M5  Human Control Plane     open questions (probe-before-ask), Question Queue UI,
                            Decision Lock + change requests, Changes review UI,
                            discussion vs implementation mode, MVP acceptance run
                            — CLOSED, fully built

M6  Polish and Scale        multi-account registry, workflow templates as data,
                            settings UI, packaging/auto-update/release pipeline,
                            audit timeline + report export
                            — CLOSED, fully built

M7  Usability and Real      first hands-on usability pass against a real repo.
    Agent Wiring            Found: no real credentials could ever be stored, mock
                            output looked identical to verified output, unbuilt
                            pages were reachable from nav, a dev gallery shipped
                            to prod, multi-line prompts didn't survive node-pty on
                            Windows (#131), --safe-mode blocked a project's own
                            CLAUDE.md from reaching the agent (#133).
                            — mostly CLOSED. Still open: #117 (Tasks page — build
                              it or decide it's not a real concept), #138 (agent
                              instance identity/naming), #142 (a tsconfig that
                              typechecks nothing)

M8  Live Agent Channel      SUPERSEDED by M11's approach, see section 3. Some
                            issues closed (#150/#151/#152 — the NDJSON stream
                            parsers, now considered a detour), some still open and
                            effectively obsolete (#153/#154/#155 — pushing those
                            parsed events to the renderer, binding a decoy
                            terminal to a step). This whole milestone's premise
                            (parse-and-re-render) was the mistake M11 reverses.

M9  Warm Sessions and       SUPERSEDED. Its whole goal (a session that survives
    Speed                   across steps, via --resume) falls out for free once a
                            session is hosted interactively rather than spawned
                            per turn (see ADR-003). All 4 issues (#156-159) still
                            open but conceptually redundant with M11.

M10 Interactive Control     SUPERSEDED. Its goal (type into a running agent,
                            real approval gate) also falls out of hosting the CLI
                            interactively — an interactive session already
                            accepts a second prompt; there is no separate
                            "interjection" subsystem to build. All 5 issues
                            (#160-164) still open but conceptually redundant.

M11 Host the Real CLI       THE CURRENT, ACTIVE MILESTONE. See section 3 in full.
```

**Important nuance for a refactor**: M8/M9/M10's issues are still open in the
tracker, but they describe solving problems that M11's architecture makes
unnecessary. A refactor should not "complete" M8/M9/M10 as separately scoped
work — it should either close them as superseded (referencing M11) or fold
anything still genuinely useful (e.g. #159's benchmark harness idea) directly
into M11/M12-style work. Building the M8 NDJSON-push-to-renderer pipeline now
would be re-doing exactly the mistake M11 exists to undo.

---

## 3. The M11 pivot — what changed, why, and the mistake behind it

### 3.1 The reference point (do not name it in any commit, issue, or PR)

Partway through this project, its owner pointed to **a separate, mature,
already-working AI coding-agent orchestrator** as a study reference — not to copy
its code, but to understand its *architecture* and compare it against what Forge
had built, to see what Forge was missing and doing wrong. This was explicit
guidance from the owner, given with one hard constraint that must keep being
honored in every artifact written about this, forever:

> **Never name that reference product in any GitHub issue, commit message, PR, or
> other project artifact.** Every ADR, the NORTH-STAR doc, and every issue
> describes it only as "a mature orchestrator" / "a mature implementation of
> this" and cites only measured, generic facts (e.g. "20+ agent adapters", "a
> real terminal multiplexer with per-client attach") — never the product's name,
> its repo, or any branding. This document follows the same rule. If you (the
> agent reading this) are asked to write anything else about this history, keep
> following it.

What was learned from studying it and comparing against Forge's own measured
behavior is recorded permanently in `docs/NORTH-STAR.md` (read that file in
full — it is short and it is the single best summary of "why" in this whole
codebase) and in `docs/decisions/ADR-003-host-the-real-cli.md`.

### 3.2 What Forge had built first (M8), and why it was wrong

Forge originally spawned every agent **headless, once per turn**:

```
claude -p --output-format stream-json --verbose --safe-mode
```

- `-p` = one-shot: give it a prompt, get one reply, the process exits.
- `--output-format stream-json` = ask it to emit NDJSON events on stdout instead
  of drawing its normal terminal UI.
- `--safe-mode` = **the actual mistake**. This flag strips the CLI's own
  customizations — **including its hook system**, which is the CLI's own
  mechanism for reporting what it's doing (SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse, PermissionRequest, Stop, Notification, SessionEnd).

So Forge disabled the CLI's built-in reporting channel, and then spent an entire
milestone (M8) rebuilding a **weaker substitute** by hand-parsing stdout: one
bespoke parser per provider (`claudeStream.ts`, `antigravityStream.ts`), each
guessing at an undocumented wire format that could change without notice.

Measured result, driving the actual packaged app as a real user against a real
target repository:

```
the pane labelled "Live CLI Terminal"   was a styled log of PARSED events,
                                        not a real terminal
the pane beside it                     spawned a SECOND, unrelated CLI session
                                        (a decoy)
the input box under it                 reached nothing at all — it showed a
                                        toast saying "Input submitted to agent
                                        console" while doing nothing
one workflow run                       took 15.4 minutes, against ~2-3 minutes
                                        for the owner doing the same task by hand
```

Forge was **roughly 3x slower and strictly less capable** than the manual
workflow it existed to replace. That is the number written down as the baseline
to beat (`docs/NORTH-STAR.md`).

### 3.3 The inversion (ADR-003, the actual fix)

```
WRONG (M8, what got built first)
  spawn the CLI headless -> parse its stdout -> re-render it in Forge's own UI

RIGHT (M11, the current direction)
  launch the CLI INTERACTIVELY -> attach a real terminal emulator to that
                                   live process
                                -> learn turn-completion/state from the CLI's
                                   OWN hooks, not from parsing anything
```

Four properties this buys, all stated in NORTH-STAR.md:

```
transparency   the user sees the real CLI — its thinking, tool calls, diffs —
                rendered by the tool that already renders them best
control        the user types into the live session directly; "correcting an
                agent mid-flight" becomes a write to the pty, not a new
                subsystem someone has to build
speed          a hosted session is warm by construction; no cold-spawn/
                rebuild-context cost paid on every workflow stage
extensibility  adding a provider becomes "a launch command plus a hook map,"
                not "write a new stdout parser against an undocumented format"
```

What the reference implementation has that Forge does not yet (recorded,
without naming it, in NORTH-STAR.md):

```
20+ agent adapters       (claude, agy, and many others named generically)
a real multiplexer       tmux-class on Linux, ConPTY-class on Windows, with
                         per-client attach and a faithful repaint on reconnect
hook-driven state        activity/blocked-on-permission/idle REPORTED by the
                         CLI, not inferred from output
pre-launch trust         Forge now has this too (ClaudeTrustStore)
worktree per session     Forge already had this, and had it right
a board view             Idle / Working / Needs You / In Review / Ready to merge
```

One specific technical lesson pulled from studying that terminal package's own
documentation and worth keeping in view for any future terminal work: **sharing
one PTY and replaying a byte ring buffer to a late-attaching subscriber loses the
terminal's init handshake**, which silently kills mouse reporting and wheel
scroll in the reattached view. The fix pattern (spawn a fresh attach per client
so the runtime re-sends that handshake by construction) is the difference
between a pane that actually feels like a terminal and one that almost does.

### 3.4 The specific bugs found and fixed while building M11 (this session and the one before it)

These are concrete, verified-against-the-real-CLI findings, not speculation:

1. **`#131` — a multi-line prompt does not survive `node-pty` on Windows the way
   it does over a plain pipe.** This is why the *headless* `ClaudeCliRuntime`
   deliberately uses `createPipeProcessRunner` (stdin pipe) rather than a pty —
   see `src/main/index.ts`'s comment on this exact point. A pty makes the child
   see a TTY and take an interactive-mode code path even under `-p`.

2. **Trust dialog blocks every fresh worktree** (`#166` family). Every new
   working directory triggers a blocking "Quick safety check" dialog on first
   launch. Fixed by `ClaudeTrustStore` pre-writing
   `hasTrustDialogAccepted: true` into `~/.claude.json`'s `projects` map before
   spawn (paths stored with forward slashes even on Windows — a real, easy-to-miss
   detail).

3. **Four failed screen-scraping heuristics for "has the turn finished?"**,
   all measured and all wrong, documented in full with numbers in
   `docs/CLI-FIELD-GUIDE.md` §9 (now marked RESOLVED, but the failure history is
   kept as a permanent lesson, not deleted):
   - hint text ("`for shortcuts`"/`Try "`) → 240s timeout; that text never
     appears under `--dangerously-skip-permissions`
   - prompt caret visible → 13.5s but wrong (caret returns within ~1s of
     submitting, while the agent is still working)
   - caret + "screen changed since submit" → 2.6s but still wrong (the screen
     changes constantly from spinners/elapsed-time counters even mid-work)
   - the validation instrument itself was broken (a `claude-mem` plugin banner
     contained the literal string "`:37777`", producing a false positive against
     a naive "is 42 on screen" check) — meaning even the tool used to judge the
     other three heuristics couldn't be trusted
   - **The actual fix**: stop reading the screen for completion. Use the CLI's
     own `Stop` hook, whose payload's `last_assistant_message` is the exact
     reply text, byte for byte, and which fires while the process is still
     running.

4. **Boot noise swallows the first prompt.** The prompt caret appears within
   about a second of boot, but MCP-authentication warnings, `SessionStart` hook
   output, and plugin banners keep painting for several seconds after that. A
   prompt typed as soon as the caret appears gets answered against that trailing
   noise instead of the real task. Fixed by `HostedSession.waitForBootSettled()`
   — wait for the caret, then wait again until the screen stops changing for
   ~1.5s, run once per session before its first turn only.

5. **Prompt truncation via undermarked "paste" detection** (fixed this session,
   commit `cba973f`). A real prompt (~1300 characters once
   `renderPromptPacket()` renders `REPORT_INSTRUCTIONS`, etc.) sent as one plain
   `write()` call gets captured by the CLI's own Ink-based input as a "paste," by
   arrival-timing heuristic alone — but with no bracketed-paste markers telling
   it where that paste started, only the *tail* of the prompt survived to what
   actually got submitted. Measured directly: a ~500-char prompt landed intact;
   the real ~1300-char production prompt showed `[Pasted text #1] paste again to
   expand` in the CLI's own input box, and the model answered as if given only a
   fragment about a report JSON schema. Fixed in
   `src/main/runtimes/interactiveTurn.ts`'s `promptKeystrokes()`, which now wraps
   the flattened prompt in real `\x1b[200~ … \x1b[201~` bracketed-paste markers.
   Verified end-to-end against the real CLI: the same prompt now reads the
   objective, calls the right tool, and reports correctly (turn time down from a
   136s failing run to a correct 15.85s completion).

### 3.5 What is done vs. what is NOT done in M11 — be precise here

```
DONE, verified against the real CLI, unit-tested:
  ClaudeTrustStore              pre-trusts a worktree before spawn (#166 class)
  claudeSessionId()             deterministic UUID v5 session id from
                                 {workflowId, stepIndex, iteration}
  permissionForRole()            plan / bypassPermissions decision, with a
                                 stated reason, per role
  HostedSession                  @xterm/headless-backed screen state: screen(),
                                 visible(), waitForPrompt(), waitForBootSettled(),
                                 the (now fallback-only) runTurn()
  ClaudeHookBridge                installs Stop + PermissionRequest hooks per
                                 worktree via a file-based receiver script
                                 (NOT an inline -e script — two earlier quoting
                                 approaches broke on shell-layer quote loss);
                                 watches a JSONL log file for the next event
  HostedClaudeRuntime             implements IAgentRuntime, id
                                 'claude-cli-hosted', registered ALONGSIDE (not
                                 replacing) the headless ClaudeCliRuntime;
                                 runTurnByHook() races the hook log against a
                                 mid-turn permission-dialog screen-watch and a
                                 timeout
  interactiveTurn.ts             promptKeystrokes() (now bracketed-paste
                                 wrapped), isPromptReady(), blockingPrompt(),
                                 turnLooksComplete()
  bracketed-paste fix            #169 finished, this session (commit cba973f)

NOT DONE — concrete gaps, not vague ones:
  hookReceiverDir wiring          HostedClaudeRuntime is constructed in
                                 src/main/index.ts WITHOUT a hookReceiverDir
                                 option. This means the hosted runtime as
                                 actually wired into the running app falls back
                                 to the (known-unreliable) screen-scraping
                                 runTurn() path, NOT the fixed hook-driven path,
                                 unless something wires hookReceiverDir in.
                                 THIS IS A REAL, IMMEDIATE GAP.
  default runtime selection       Both ClaudeCliRuntime (headless, id
                                 'claude-cli') and HostedClaudeRuntime (id
                                 'claude-cli-hosted') are registered. Which one
                                 a role actually uses is decided by a BINDING,
                                 not a hardcoded default in favor of the hosted
                                 one. So today, most real workflow runs are
                                 still going through the OLD headless path
                                 unless a binding was explicitly pointed at
                                 claude-cli-hosted.
  #167 (issue itself)             still OPEN in the tracker, even though its
                                 definition-of-done is functionally satisfied by
                                 HostedClaudeRuntime — it was never closed
                                 because it's tracked as "replace ClaudeCliRuntime
                                 outright," and that replacement (deleting the
                                 old one, or making the hosted one the default)
                                 has not happened
  #168 — Antigravity hosted       NOT STARTED AT ALL. Only Claude has a hosted/
                                 interactive runtime. AntigravityCliRuntime is
                                 still headless-only, still uses
                                 antigravityStream.ts NDJSON parsing.
  #170 — attach the pane          NOT DONE. AgentSessionRegistry exists
                                 (publish/retire/lookup a session's process by
                                 workflowId+stepIndex) and HostedClaudeRuntime
                                 does call options.onProcess?.() to publish its
                                 process — but nothing in the renderer actually
                                 attaches a live terminal component to that
                                 published process yet. The workflow UI still
                                 shows whatever it showed before (check the
                                 renderer file-inventory part of this doc for
                                 the exact current state of RealTerminal.tsx /
                                 AgentTerminal.tsx / WorkflowPage.tsx).
  #171 — mid-run interjection     NOT DONE. send() only supports a fresh
                                 prompt at turn start; there is no path yet for
                                 the user to type into an ALREADY-RUNNING turn
                                 and have it treated as an interjection rather
                                 than the next queued prompt.
  #172 — delete the old parsers   NOT DONE. claudeStream.ts and
                                 antigravityStream.ts both still exist and are
                                 still imported by claudeCliRuntime.ts and
                                 antigravityCliRuntime.ts respectively. Deleting
                                 them is explicitly gated on #170/#171 landing
                                 first (the milestone's own stated sequencing).
  workflow-level use of hooks      #169's hook mechanism has only been proven
                                 for a SINGLE turn in isolation (a probe/
                                 integration test), not yet for a real five-stage
                                 workflow with retries, corrections, and role
                                 handoffs running through the full
                                 orchestrator/WorkflowService pipeline.
```

### 3.6 The measured cost/benefit, restated plainly

Before this pivot, real end-to-end runs against a real target repository showed
Forge at **~3x slower and less capable** than the owner doing the same task by
hand, with the UI showing decoys (a second unrelated CLI session, an input box
that reached nothing). After the pivot's Claude-hosted path specifically: a
single real turn dropped from either a 136-second failing/garbled run down to a
correct 15.85-second completion once both the boot-noise bug and the bracketed-
paste truncation bug were fixed. That number is for ONE hosted turn in isolation,
verified via probe/integration test — it is not yet a measurement of a full
real workflow end-to-end on the hosted path, because the wiring gaps in 3.5
above mean a full workflow does not yet run entirely on that path.

---

## 4. Directly relevant docs already in the repo (read these, do not re-derive them)

```
README.md                     what Forge is, the seven axioms
docs/NORTH-STAR.md             the single best "why" document — read in full
docs/CLI-FIELD-GUIDE.md        every measured fact about the CLIs' actual
                               behavior: trust dialog, permission modes, session
                               ids, output formats, rate-limit gotchas, ConPTY/
                               Windows traps, and §9's full RESOLVED history of
                               the turn-completion problem
docs/ARCHITECTURE.md           process boundaries, IPC contract, verification
                               layers
docs/DOMAIN.md                 entities, the state machine (spec, not all of it
                               may be code yet — check against Part 3 of this
                               handoff for the actual current domain files)
docs/PLAN.md                   milestones, known toolchain traps
docs/FORGE_RULES.md             the agent policy set Forge enforces ON AGENTS
docs/decisions/ADR-001-agents-runtimes-accounts.md (+ -TASKS.md)
                               multi-provider architecture decision (#62-64)
docs/decisions/ADR-002-interactive-orchestration.md
                               the FIRST attempt at fixing M8 — SUPERSEDED by
                               ADR-003, kept for the historical record of what
                               was tried and replaced
docs/decisions/ADR-003-host-the-real-cli.md
                               the actual, current architecture decision — read
                               this in full, it is short
docs/spikes/interactive-cli-pty.md
docs/spikes/agent-cli-capability.md
CONTRIBUTING.md                branch flow, commands, lint-enforced boundaries
```

---

## 5. Practical guidance for a refactor

- Do not "fix" M8/M9/M10 issues by building what they literally ask for. Check
  whether M11's architecture already makes that issue's goal a non-issue; if so,
  the right action is closing it as superseded (with a comment saying so), not
  implementing it.
- The single highest-leverage next step, if picking up where this left off, is
  wiring `hookReceiverDir` into the `HostedClaudeRuntime` construction in
  `src/main/index.ts` — without that one line, everything built for #169 is
  inert in the actual running app.
- Do not delete `claudeStream.ts`/`antigravityStream.ts` casually — they are
  still load-bearing for the headless runtimes, which are still what most real
  workflow runs actually use today. Deleting them is correctly gated behind
  #170/#171 landing, per the milestone's own issue (#172).
- Never name the external reference orchestrator in any commit, issue, PR, or
  other artifact this project produces. Describe it only in the generic terms
  already used in NORTH-STAR.md and ADR-003.
- When in doubt about a fact ("does X already work?", "is Y wired up?"), verify
  by reading the actual code and, where plausible, running it against the real
  CLI — this project's own explicit standard (A3, and its CLAUDE.md) is evidence
  over claims. Several real, would-have-shipped bugs in this codebase were only
  found by actually running the full pipeline against a real repository rather
  than trusting that green tests meant a working feature.
# Forge — Handoff Document, Part 2: `src/main/db/`, `src/main/runtimes/`, `src/main/git/`

## `src/main/db/`

### `src/main/db/connection.ts`

**Purpose:** Opens the SQLite database file (via `better-sqlite3`) and applies the pragmas Forge depends on for correctness and concurrency.

**What it does:** Exports `openDatabase({ file })` which creates a `better-sqlite3` connection, enables `foreign_keys = ON` (SQLite disables FK enforcement by default), and for non-`:memory:` files sets `journal_mode = WAL` and `synchronous = NORMAL` (so readers/writers don't block each other while the event log is the recovery mechanism). Sets `busy_timeout = 5000` to fail fast rather than hang on a lock. Returns `{ db, sqlite, close }` where `db` is a Drizzle `BetterSQLite3Database<typeof schema>` (aliased as `ForgeDatabase`). Also exports `readPragmas(sqlite)` to read back `foreign_keys`/`journal_mode` for tests to assert they took effect.

**Calls/depends on:** `better-sqlite3`, `drizzle-orm/better-sqlite3`, `./schema`.

**Called from/used by:** `src/main/db/index.ts` (`initialiseDatabase`), and transitively every consumer of `ForgeDatabase` type (workflowService.ts, projectService.ts, etc.) via `db/index.ts`.

---

### `src/main/db/schema.ts`

**Purpose:** The Drizzle SQLite table definitions mirroring `src/shared/domain`; the single source of truth for storage shape.

**What it does:** Defines tables: `projects`, `repositories` (1:1 with project via unique FK), `rules` (unique on `(projectId, scope, key)`), `agentBindings` (unique on `(projectId, role)`), `decisions` (indexed on `(projectId, status)`), `openQuestions` (indexed on `(answeredAt, askedAt)` for the "unanswered-first" queue), `tasks`, `workflows` (indexed on `(projectId, state)` for interrupted-workflow lookup), `workflowSteps` (unique on `(workflowId, stepIndex)`), `changeSets` (indexed on `(taskId, capturedAt)`), `evidenceArtifacts` (indexed on `(stepId, recordedAt)`), `events` (composite PK `(projectId, seq)`, unique `id`, indexed on `(projectId, type)`; **deliberately has no FK to `projects`** so the log is never cascaded away when a project's projection is deleted), and `accounts`. All ids are domain UUID strings used directly as primary keys; timestamps are ISO-8601 text; booleans are integers; structured values (JSON) are opaque text columns validated by Zod at the boundary. Note: `schema_meta` (migration tracking) is intentionally NOT declared here — see `migrate.ts`.

**Calls/depends on:** `drizzle-orm/sqlite-core` only.

**Called from/used by:** `connection.ts` (passed to `drizzle()`), every store/repository file in `db/` (`accountStore`, `bindingStore`, `changeSetStore`, `decisionStore`, `eventStore`, `projectRepository`, `projectStore`, `projections`, `questionStore`, `ruleRepository`, `workflowStore`), re-exported as `schema` from `db/index.ts`.

---

### `src/main/db/rows.ts`

**Purpose:** Shared helpers translating between SQLite's text-only storage and typed/structured domain values.

**What it does:** `toJson(value)` → `JSON.stringify`. `fromJson(schema, raw, context)` → parses JSON then validates via a Zod schema, throwing a message naming the offending column on failure. `parseRow(schema, value, context)` → validates an assembled row object against a full domain schema (catches an invariant violation, e.g. "a locked decision must name its locker"). `toSqliteBoolean`/`fromSqliteBoolean` → int↔bool since SQLite has no boolean type.

**Calls/depends on:** `zod` only.

**Called from/used by:** Nearly every store file: `accountStore`, `bindingStore`, `changeSetStore`, `decisionStore`, `projectRepository`, `projections`, `questionStore`, `ruleRepository`, `workflowStore`.

---

### `src/main/db/eventStore.ts`

**Purpose:** The append-only event log — the single source of truth (axiom A1/A3) that every read model is a derived projection of.

**What it does:** `EventStore` class wraps `ForgeDatabase`. `append(input, options)` appends one event (delegates to `appendMany`). `appendMany(inputs, options)` validates every payload against `EVENT_PAYLOADS[type]` (via exported `validatePayload`) **before** any write, then in one transaction reads `max(seq)` for the project (SQLite serializes writers so this is race-free; the `(projectId, seq)` PK also rejects any collision), assigns consecutive `seq` numbers, and inserts each event with a fresh `randomUUID()` id (parsed through `eventIdSchema`). `read(projectId)` returns all events ordered by `seq`. `readSince(projectId, seq)` for incremental projection catch-up. `latestSeq(projectId)`. `projectIds()` returns every project id that has any events (used to rebuild all projections at startup). Internal `toDomainEvent` re-parses payload JSON and validates the whole event against `domainEventSchema` on the way *out* too, so a hand-edited or stale row fails loudly rather than silently corrupting a projection.

**Calls/depends on:** `@shared/domain` (`domainEventSchema`, `eventIdSchema`, `EVENT_PAYLOADS`, types), `./connection` (`ForgeDatabase`), `./schema` (`events` table). `node:crypto` for `randomUUID`.

**Called from/used by:** Every command-layer store (`accountStore`, `bindingStore`, `changeSetStore`, `decisionStore`, `projectStore`, `questionStore`, `workflowStore`) constructs or receives an `EventStore` and calls `.append`/`.appendMany`. Also directly imported by `src/main/index.ts`, `src/main/bindings/bindings.test.ts`, `src/main/evidence/reconciliation.integration.test.ts`, `src/main/runtimes/accountSwitch.integration.test.ts`, `src/main/runtimes/orchestrator.test.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/db/projections.ts`

**Purpose:** Applies each domain event to the projected (read-model) tables; this is the ONLY writer of those tables.

**What it does:** Exports `applyEvent(db, event)` — an exhaustive (by construction) switch-like chain over every `EventType` using an `isType` type-guard narrower. Handles: `project.created`/`project.updated`, `repository.bound`, `rule.set`/`rule.removed`, `task.created`, `workflow.started`/`transitioned`/`checkpointed`/`halted`/`finished`, `step.started`/`step.finished`, `evidence.recorded`, `question.asked`/`question.answered`, `decision.proposed`/`approved`/`locked`/`superseded`, `changeset.captured`/`reviewed`, `account.registered`/`status_updated`/`removed`, `binding.set`. Every writer is an **absolute upsert** (`onConflictDoUpdate` or unconditional `.set`), never a read-modify-write — this is what makes replay idempotent (re-applying an event twice yields the same row; critical because resume re-applies the tail of the log). Falls through to a no-op for types listed in `PROJECTED_LATER` (currently empty), and **throws** for any genuinely unhandled event type — a silent skip would mean the projection quietly disagrees with the log. Also exports `rebuildProjections(db, projectId, events)`: deletes the project row (cascades remove children) then replays every event through `applyEvent` inside one transaction — used to verify projections are truly derived, and for recovery.

**Calls/depends on:** `drizzle-orm` (`eq`), `@shared/domain` types, `./connection`, `./schema` (all projected tables), `./rows` (`toJson`).

**Called from/used by:** Every store's mutation method (`accountStore`, `bindingStore`, `changeSetStore`, `decisionStore`, `projectStore`, `questionStore`, `workflowStore`) calls `applyEvent` right after `events.append`. `rebuildProjections` used by `projectStore.rebuild`/`rebuildAll`. Also imported directly by `src/main/evidence/reconciliation.integration.test.ts` and `src/main/runtimes/orchestrator.test.ts`.

---

### `src/main/db/migrate.ts`

**Purpose:** Applies committed SQL migrations forward-only, tracking the applied count in a bootstrap `schema_meta` table — without reading migration files off disk at runtime.

**What it does:** `loadMigrations(directory)` reads `*.sql` files from a directory sorted lexically (drizzle-kit's `0000_`, `0001_...` naming makes lexical order = application order) — used only by the dev/generate tooling, not at app runtime. `runMigrations(db, migrations)` — the actual runtime path — first creates `schema_meta` (`CREATE TABLE IF NOT EXISTS`) if absent (bootstrapped outside migration files since it must exist before anything can be recorded as applied), reads the currently-applied count via `readAppliedCount`, then for each remaining migration runs its statements (split on `--> statement-breakpoint`, drizzle-kit's separator) inside one transaction together with an `INSERT ... ON CONFLICT DO UPDATE` bump of the `migration_version` key — so a failure mid-migration leaves the DB at the previous consistent version rather than half-migrated. Returns how many migrations were newly applied. `readAppliedCount(db)` reads `schema_meta` for `migration_version`, defaulting to 0.

**Calls/depends on:** `drizzle-orm` (`sql`), `node:fs` (`readdirSync`, `readFileSync`), `node:path`, `./connection`.

**Called from/used by:** `src/main/db/index.ts` (`initialiseDatabase`) calls `runMigrations(db, MIGRATIONS)`. `loadMigrations`/`runMigrations`/`readAppliedCount` re-exported from `db/index.ts`; no other direct external consumers found (mainly exercised by `db.test.ts`).

---

### `src/main/db/migrations.generated.ts`

**Purpose:** Generated (via `npm run db:generate`) inlined copy of every `.sql` migration under `src/main/db/migrations/`, so a packaged Electron app never needs to read migration files from disk (avoids an unpacked-resource packaging failure mode).

**What it does:** Exports `MIGRATIONS: readonly Migration[]` — a literal array of `{ tag, sql }` currently containing three migrations: `0000_initial` (creates all core tables: `agent_bindings`, `change_sets`, `decisions`, `events`, `open_questions`, `projects`, `repositories`, `rules`, `tasks`, `workflow_steps`, `workflows`, plus their indexes), `0001_wonderful_raider` (adds `evidence_artifacts`), `0002_accounts` (adds `accounts`). **Do not edit by hand** — regenerated from the `.sql` source files.

**Calls/depends on:** `./migrate` (only the `Migration` type).

**Called from/used by:** `db/index.ts` imports `MIGRATIONS` and re-exports it; `initialiseDatabase` passes it to `runMigrations`.

---

### `src/main/db/index.ts`

**Purpose:** The public barrel/entry point for the whole `db` module — the one thing outside code imports (`from '../db'` / `from './db'`).

**What it does:** Re-exports `openDatabase`, `readPragmas`, `ForgeDatabase`, `OpenDatabaseResult` from `connection.ts`; `loadMigrations`, `readAppliedCount`, `runMigrations`, `Migration` from `migrate.ts`; `planResume`, `resumeDecisionSchema`, `WorkflowStore`, `ResumeDecision`, `ResumePlan`, `StartWorkflowInput` from `workflowStore.ts`; `* as schema` from `schema.ts`; `MIGRATIONS` from `migrations.generated.ts`. Defines and exports `initialiseDatabase(file)`: opens the DB, runs migrations, and returns `{ db, sqlite, close, applied }`; on migration failure it **closes the handle before rethrowing** so a failed migration never holds a lock on a database the app cannot use.

Note: this barrel does **not** re-export `AccountStore`, `BindingStore`, `ChangeSetStore`, `DecisionStore`, `EventStore`, `ProjectRepository`, `ProjectStore`, `QuestionStore`, `RuleRepository`, `applyEvent`/`rebuildProjections`, or the `rows.ts` helpers — consumers reach those via direct file imports (e.g. `'../db/eventStore'`), only `WorkflowStore` and the connection/migration primitives go through the barrel. This is somewhat inconsistent and worth flagging for the refactor.

**Calls/depends on:** `connection.ts`, `migrations.generated.ts`, `migrate.ts`, `workflowStore.ts`, `schema.ts`.

**Called from/used by:** `src/main/index.ts` (Electron main bootstrap) calls `initialiseDatabase`; many test files (`dogfood.manual.test.ts`, `mvpAcceptance.test.ts`, `bindings.test.ts`, `reconciliation.integration.test.ts`, `projects.test.ts`, `accountSwitch.integration.test.ts`, `orchestrator.test.ts`, `workflowService.test.ts`) import `initialiseDatabase`/`ForgeDatabase` from `'../db'`. `projectService.ts` imports the `ForgeDatabase` type from `'../db'`.

---

### `src/main/db/projectRepository.ts`

**Purpose:** Read-only query layer for `Project` (joined with its 1:1 `Repository`).

**What it does:** `ProjectRepository` class: `findById(id)` inner-joins `projects`+`repositories` on `repositories.projectId = projects.id`, returns `null` if absent. `list()` returns every project (with its repository). Private `toDomain(row)` assembles and **validates** the combined row through `repositorySchema` then `projectSchema` via `parseRow`, throwing with a precise message if a hand-edited or stale row doesn't match. Explicitly documented as read-only by design: all mutation must go through `ProjectStore`, since a direct write here would create state with no event behind it, invisible to the audit trail and erased by the next rebuild.

**Calls/depends on:** `drizzle-orm` (`eq`), `@shared/domain` (`projectSchema`, `repositorySchema`, types), `./connection`, `./rows` (`fromJson`, `parseRow`), `./schema` (`projects`, `repositories`), `zod`.

**Called from/used by:** Only `ProjectStore` (`projectStore.ts`) instantiates and delegates to it (`this.reader`). No other direct external imports found.

---

### `src/main/db/projectStore.ts`

**Purpose:** The command layer for projects — every mutating operation on a project, its bound repository, and its rules.

**What it does:** `ProjectStore` wraps an internal `EventStore` and `ProjectRepository`. `create(project, actor)`: appends **two** events (`project.created` then `repository.bound`) in one transaction, applying each via `applyEvent` — so no observer ever sees a project without a repository (an unusable intermediate state). `rename(projectId, name, actor, occurredAt)`: appends `project.updated`. `updateRepository(projectId, repository, actor, occurredAt)`: appends a **new** `repository.bound` event rather than mutating in place — deliberately, so the event log preserves what the settings (notably `defaultBranch`) were at the time each past workflow ran (referencing the #100 defect about silently reinterpreting historical changesets). `setRule`/`removeRule`: append `rule.set`/`rule.removed`. `findById`/`list`: delegate to the read-only `ProjectRepository`. `rebuild(projectId)`/`rebuildAll()`: call `rebuildProjections` for one or every project (via `events.projectIds()`) — used by the replay test and for recovery after a projection bug. `delete(projectId)`: deletes the `projects` row (cascades clean up `repositories`, `rules`, `agentBindings`, `decisions`, `openQuestions`, `tasks`, `workflows`, `changeSets` via FK `onDelete: cascade`) **and** explicitly deletes matching `events` rows in the same transaction (since the event table deliberately has no FK to cascade from).

**Calls/depends on:** `drizzle-orm` (`eq`), `@shared/domain` types, `./connection`, `./schema` (`* as schema`), `./eventStore` (`EventStore`), `./projections` (`applyEvent`, `rebuildProjections`), `./projectRepository` (`ProjectRepository`).

**Called from/used by:** `src/main/evidence/reconciliation.integration.test.ts`, `src/main/projects/projects.test.ts`, `src/main/projects/projectService.ts`, `src/main/runtimes/orchestrator.test.ts`.

---

### `src/main/db/ruleRepository.ts`

**Purpose:** Read-only query layer for `Rule` rows.

**What it does:** `RuleRepository.listForProject(projectId)` — all rules for a project, ordered by `scope` then `key` for stable rendering. `findByKey(projectId, scope, key)` — a single rule lookup. Private `toDomain` validates via `parseRow(ruleSchema, ...)`. Documented as read-only by design for the same reason as `ProjectRepository`: rules are projected from `rule.set`/`rule.removed` events; writing here would create untracked state. Explicitly notes scope resolution (global→task, most specific wins) is a separate concern (#19) not implemented here — this only returns what is stored as-is.

**Calls/depends on:** `drizzle-orm` (`and`, `asc`, `eq`), `@shared/domain` (`ruleSchema`, types), `./connection`, `./rows` (`parseRow`), `./schema` (`rules`).

**Called from/used by:** `src/main/projects/projectService.ts` only (no other direct imports found).

---

### `src/main/db/accountStore.ts`

**Purpose:** Persists and manages provider accounts (multi-account support, #44) — switching accounts changes only runtime credentials/sessions, never project state.

**What it does:** `AccountStore` wraps `ForgeDatabase` + `EventStore`. `find(id)` / `list(provider?)` read from `accounts` table. `register(account, actor, occurredAt)`: validates via `accountSchema`, then — notably — parses `account.id` through `projectIdSchema` to use as the event's `projectId` (accounts are stored in the same event log keyed by their own id acting as a pseudo-project-id — a slightly unusual reuse worth flagging), appends `account.registered`, applies it, and re-reads to confirm. `updateStatus(accountId, status, actor, occurredAt, lastUsedAt?)`: appends `account.status_updated`. `remove(accountId, actor, occurredAt)`: appends `account.removed`. Private `toAccount(row)` validates via `accountSchema`.

**Calls/depends on:** `drizzle-orm` (`eq`), `@shared/domain` (`accountSchema`, `projectIdSchema`, types), `./connection`, `./eventStore` (`EventStore`), `./projections` (`applyEvent`), `./rows` (`parseRow`), `./schema` (`accounts`).

**Called from/used by:** `src/main/accounts/accountService.ts`, `src/main/index.ts`, `src/main/runtimes/accountSwitch.integration.test.ts`.

---

### `src/main/db/bindingStore.ts`

**Purpose:** Persists which runtime holds which role, per project (#31, #102) — the storage half of axiom A6's role/runtime indirection.

**What it does:** `BindingStore.list(projectId)` — all bindings for a project. `find(projectId, role)` — one binding. `set(projectId, binding, actor, occurredAt)`: validates via `agentBindingSchema`, appends `binding.set`, applies, re-reads to confirm and return. Private `toBinding(row)` parses the JSON `capabilities` (array of `capabilitySchema`) and `permissions` (`permissionsSchema`) columns back through their schemas via `fromJson`.

**Calls/depends on:** `drizzle-orm` (`and`, `eq`), `zod`, `@shared/domain` (`agentBindingSchema`, `capabilitySchema`, `permissionsSchema`, types), `./connection`, `./eventStore`, `./projections` (`applyEvent`), `./rows` (`fromJson`), `./schema` (`agentBindings`).

**Called from/used by:** `src/main/bindings/bindings.test.ts`, `src/main/bindings/bindingService.ts`, `src/main/index.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/db/decisionStore.ts`

**Purpose:** Persists and manages `Decision`s — implements axiom A4: decisions are binding once approved/locked, and **only** the `user` actor may lock, unlock, or supersede one.

**What it does:** `DecisionStore.find`/`listForProject(projectId, status?)`/`listLocked(projectId)` are reads. `propose(decision, projectId, actor, occurredAt)` appends `decision.proposed`. `approve(decisionId, actor, occurredAt)` appends `decision.approved`. `lock(decisionId, actor, occurredAt)` — **throws** if `actor !== 'user'` ("Axiom A4 violation"), else appends `decision.locked`. `supersede(decisionId, replacement, actor, occurredAt)` — also user-only-enforced; inside one transaction appends up to three events: propose the replacement, optionally lock it immediately if `replacement.status === 'locked'`, then mark the original `decision.superseded`; returns both updated decisions. `promoteFromQuestion(questionId, statement, rationale, actor: 'user', occurredAt, projectId, decisionId)` builds a fully-locked `Decision` object referencing `originQuestionId` and calls `propose`. Private `projectIdOf(decisionId)` looks up a decision's project id for building later events. `toDecision(row)` validates via `parseRow(decisionSchema, ...)`.

**Calls/depends on:** `drizzle-orm` (`and`, `eq`), `@shared/domain` (`decisionSchema`, `projectIdSchema`, types), `./connection`, `./eventStore`, `./projections` (`applyEvent`), `./rows` (`parseRow`), `./schema` (`decisions`).

**Called from/used by:** `src/main/decisions/decisionService.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/db/questionStore.ts`

**Purpose:** Persists and queries `OpenQuestion`s — implements axiom A2 ("unknown != assume"): when an agent cannot resolve an ambiguity, it records the question with evidence here rather than guessing.

**What it does:** `QuestionStore.find(questionId)`. `listForProject(projectId, { unansweredOnly? })`. `listUnanswered()` — across all projects (used for a cross-project question queue). `ask(question, projectId, actor, occurredAt)`: validates `openQuestionSchema`, appends `question.asked`. `answer(questionId, answer, actor: 'user', occurredAt, promotedToDecisionId?)`: appends `question.answered` (carries `promotedToDecisionId` in the payload for traceability, though the projection itself doesn't currently write that field — worth checking against `projections.ts`'s `question.answered` handler, which sets only `answer`/`answeredAt`/`answeredBy`). Private `projectIdOf`. `toOpenQuestion(row)` validates via `parseRow`, decoding `evidence` (array of `evidenceRefSchema`) and `options` (array of strings) JSON columns.

**Calls/depends on:** `drizzle-orm` (`and`, `eq`, `isNull`), `zod`, `@shared/domain` (`evidenceRefSchema`, `openQuestionSchema`, `projectIdSchema`, types), `./connection`, `./eventStore`, `./projections` (`applyEvent`), `./rows` (`fromJson`, `parseRow`), `./schema` (`openQuestions`).

**Called from/used by:** `src/main/questions/questionService.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/db/changeSetStore.ts`

**Purpose:** Persists and reads `ChangeSet`s (captured diffs from a workflow step) and their review verdicts.

**What it does:** `ChangeSetStore.find(changeSetId)` / `listForProject(projectId)` are reads. `record(changeSet, projectId, actor, occurredAt)`: validates `changeSetSchema`, appends `changeset.captured`. `recordReview(input: RecordReviewInput, projectId, actor, occurredAt)`: appends `changeset.reviewed` carrying `{ changeSetId, verdict, claimedVerdict, overridden, reason, findings, reviewedBy }` — note this method does **not** re-read/return the updated row (unlike most other store mutators), it's `void`. `toChangeSet(row)` decodes `files` (array of `changedFileSchema`) and `discrepancies` (array of `discrepancySchema`) JSON columns via `fromJson`, validates the whole row via `parseRow`.

**Calls/depends on:** `drizzle-orm` (`eq`), `zod`, `@shared/domain` (`changedFileSchema`, `changeSetSchema`, `discrepancySchema`, types), `./connection`, `./eventStore`, `./projections` (`applyEvent`), `./rows` (`fromJson`, `parseRow`), `./schema` (`changeSets`).

**Called from/used by:** `src/main/changesets/changeSetService.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/db/workflowStore.ts`

**Purpose:** The command layer for workflows — the largest and most safety-critical store, since workflow execution must be crash-recoverable via write-ahead checkpointing.

**What it does:** `WorkflowStore` wraps an internal `EventStore`. Key invariant documented at the top: **the event is written before the side effect runs** — so a crash mid-step means "redo the step", never "lost step" (which is why steps must be idempotent).

- `start(input: StartWorkflowInput, actor)`: parses `limits` via `workflowLimitsSchema`, appends `workflow.started`.
- `apply(workflowId, trigger, actor, occurredAt, { reason?, questionId? })`: the core state-machine driver. Loads the current workflow, calls the pure `transition(state, trigger, { resumeState, iteration, maxIterations })` from `@shared/domain` (throws on an illegal move, so a rejected trigger never reaches the log), then in one transaction appends `workflow.transitioned`, and conditionally also `workflow.halted` (if landing on `HALTED_LIMIT`/`HALTED_POLICY`, synthesizing a default halt reason if none given) and/or `workflow.finished` (if `isTerminalWorkflowState(result.to)`). Returns the refreshed workflow.
- `checkpoint(workflowId, checkpoint, actor, occurredAt)`: validates `workflowCheckpointSchema`, appends `workflow.checkpointed` — the write-ahead record of what's about to be attempted; `lastOperation` is human-readable for the resume banner.
- `startStep`/`finishStep`: append `step.started`/`step.finished`. `startStep` is safe to call again with the same step id on resume (upsert semantics live in the projection).
- `recordEvidence(artifact, actor, occurredAt)`: validates `evidenceArtifactSchema`, appends `evidence.recorded` with payload `{ artifact, workflowId, stepId, summary: summariseEvidence(artifact) }`. Written *after* the run (unlike a step) since the artifact *is* the result.
- `evidenceForStep(stepId)`: reads ordered-by-time evidence rows, re-validates each via `parseRow`, decoding `counts` (nullable `testCountsSchema`) — the pass/fail verdict is never stored, only recomputed from the exit code by `evidencePassed` elsewhere, so no row can claim a verdict that disagrees with its own evidence.
- `findInterrupted()`: workflows where `checkpoint IS NOT NULL AND finishedAt IS NULL` — the exact definition of "was mid-step when the process died", used at startup to offer Resume/Abandon.
- `find`/`listForProject`: reads via `toDomain`.
- Private `projectIdOf`, `require` (throws if unknown), `toDomain(row)` — assembles the workflow plus its ordered `workflowSteps`, decodes `limits`/`checkpoint` JSON, and validates the whole thing via `workflowSchema` (catching e.g. an `AWAITING_USER` state with no resume state).

Also exports (module-level, not on the class): `resumeDecisionSchema` (`z.enum(['resume', 'abandon'])`), `ResumeDecision` type, `ResumePlan` interface, and `planResume(workflow)` — a pure function computing what a resume *would* do (state, step index, total steps, last operation, input ref, started-at) without doing it, so the UI can describe the choice concretely.

**Calls/depends on:** `drizzle-orm` (`and`, `asc`, `eq`, `isNotNull`, `isNull`), `zod`, `@shared/domain` (many: `evidenceArtifactSchema`, `testCountsSchema`, `isTerminalWorkflowState`, `summariseEvidence`, `transition`, `workflowCheckpointSchema`, `workflowLimitsSchema`, `workflowSchema`, `workflowStepSchema`, and many types), `./connection`, `./eventStore` (`EventStore`), `./projections` (`applyEvent`), `./rows` (`fromJson`, `parseRow`), `./schema` (`evidenceArtifacts`, `workflows`, `workflowSteps`).

**Called from/used by:** `src/main/acceptance/mvpAcceptance.test.ts`, `src/main/evidence/reconciliation.integration.test.ts`, `src/main/runtimes/orchestrator.test.ts`, `src/main/runtimes/orchestrator.ts` (as the `WorkflowStore` type for `OrchestratorDeps.workflows`), `src/main/workflows/workflowService.ts`. Re-exported from `db/index.ts` (the only store class in the barrel).

---

## `src/main/runtimes/`

### `src/main/runtimes/index.ts`

**Purpose:** The public barrel for the runtimes module, and (per its own doc comment) **the only directory allowed to name a specific agent provider** — enforced by an ESLint boundary rule (axiom A6).

**What it does:** Re-exports: `IncapableRuntimeError`, `RuntimeRegistry`, `UnknownRuntimeError` (from `registry.ts`); `bindRole`, `BindingSet`, `permits`, `requiredCapabilities`, `UnboundRoleError`, `CreateBindingInput` (from `bindings.ts`); `exchange`, `ExchangeOutcome` (from `exchange.ts`); `Orchestrator`, `UnrunnableWorkflowError`, `OrchestratorDeps`, `RunOptions`, `RunOutcome`, `StepContext` (from `orchestrator.ts`); `MockAgentRuntime`, `MockRuntimeOptions` (from `mockRuntime.ts`); `SCENARIOS`, `scenarioSchema`, `Scenario`, `ScenarioFileEdit`, `ScenarioName`, `ScenarioStep` (from `scenario.ts`); `ClaudeCliRuntime`, `ClaudeCliRuntimeOptions`, `ProcessRunner`, `ProcessRunnerResult` (from `claudeCliRuntime.ts`); `AntigravityCliRuntime`, `AntigravityCliRuntimeOptions` (from `antigravityCliRuntime.ts`). Notably **does not** re-export `HostedClaudeRuntime`/`HostedSession`, `claudeHooks`, `claudeSession`, `claudeTrust`, `claudeStream`, `antigravityStream`, `interactiveTurn`, `pipeProcessRunner`, `ptyProcessRunner` — those are imported directly by file path by their consumers (mainly `src/main/index.ts`).

**Calls/depends on:** All the files listed above.

**Called from/used by:** grep for `from '.*runtimes'` (not `/runtimes/<file>`) shows no external consumer of the barrel itself was found in this pass (most consumers import specific files directly, e.g. `'../runtimes/registry'`, `'../runtimes/mockRuntime'`).

---

### `src/main/runtimes/registry.ts`

**Purpose:** The runtime registry — the single place an `IAgentRuntime` implementation is resolved by id; enforces axiom A6 (application code never constructs a runtime directly).

**What it does:** `RuntimeRegistry` class holds a `Map<string, IAgentRuntime>`. `register(runtime)` — throws if the id is already registered (refuses silent overwrite, since two adapters answering one id would make behavior depend on registration order). `has(runtimeId)`, `list()`, `ids()`. `resolve(runtimeId)` — throws `UnknownRuntimeError` (lists what *is* registered) rather than returning null. `resolveForRole(runtimeId, role)` — resolves then checks `canHoldRole(runtime.capabilities, role)`, throwing `IncapableRuntimeError` (naming the missing capabilities) if not — checked at **binding time**, not step time, so a mismatch is caught before a workflow is half-run. `candidatesForRole(role)` — filters `list()` for the settings UI. Also exports free function `runtimeExecutable(runtimeId)` mapping `claude-cli`→`claude`, `antigravity-cli`→`agy`, falling back to the id itself — used by the enrolment flow to know which CLI executable to launch for sign-in. Deliberately **not a singleton** — each test constructs its own registry; `main/index.ts` owns the app's real one.

**Calls/depends on:** `@shared/domain` (`canHoldRole`, `missingCapabilities`, types).

**Called from/used by:** `src/main/acceptance/dogfood.manual.test.ts`, `mvpAcceptance.test.ts`, `accounts/enrollmentService.test.ts`, `accounts/enrollmentService.ts`, `bindings/bindings.test.ts`, `bindings/bindingService.ts`, `evidence/reconciliation.integration.test.ts`, `src/main/index.ts`, `src/main/ipc/handlers.ts`, `workflows/workflowService.test.ts`, `workflows/workflowService.ts`.

---

### `src/main/runtimes/bindings.ts`

**Purpose:** Resolves and enforces role→runtime bindings per project — the storage-independent logic behind axiom A6's indirection and axiom A7's least-privilege permission narrowing.

**What it does:** `ROLE_PERMISSIONS` — default permission set per `Role` (`planner`: read+plan only; `implementer`: full read/write/test/build; `reviewer`/`tester`/`security-reviewer`: read+test but never write; `system`/`user`: minimal/none). `bindRole(registry, input: CreateBindingInput)`: resolves the runtime, throws `IncapableRuntimeError` if it can't hold the role, then computes `permissions` as the **intersection** of the role's defaults and whatever the caller requested — a caller can narrow but never widen a role's permissions (enforces A7; prevents a settings screen from granting a reviewer write access). Returns a fully-validated `AgentBinding` (parsed via `agentBindingSchema`), recording the runtime's declared `capabilities` at bind time so a later capability change is visible as a diff rather than silently taking effect. `UnboundRoleError` — raised when a template needs a role nothing is bound to. `BindingSet` class: `Map<Role, AgentBinding>` wrapper; `set`, `get`, `require` (throws `UnboundRoleError`), `roles()`, `missingFor(roles)` (excludes `system`/`user`, which need no binding). `permits(binding, capability)` — checks a permission flag. `requiredCapabilities(role)` — via `missingCapabilities([], role)`.

**Calls/depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (`agentBindingIdSchema`, `agentBindingSchema`, `canHoldRole`, `missingCapabilities`, `permissionsSchema`, types), `./registry` (`IncapableRuntimeError`, `RuntimeRegistry`).

**Called from/used by:** `src/main/bindings/bindingService.ts`, `src/main/evidence/reconciliation.integration.test.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/runtimes/scenario.ts`

**Purpose:** Defines scripted `Scenario`/`ScenarioStep` fixtures consumed by `MockAgentRuntime`, so the workflow engine, evidence layer, and review loop can be built/tested without burning real agent quota or a not-yet-headless CLI.

**What it does:** Zod schemas `scenarioFileEditSchema`, `scenarioStepSchema` (fields: `narration`, `tools`, `edits`, `report` nullable, `ending: 'report'|'silent'|'crash'|'authFailure'|'text'|'providerLimit'`, `replyText`), `scenarioSchema` (`name`, `description`, `capabilities`, `steps` min 1). Helper builders `report(overrides)` and `step(overrides)`. Exports **15 named scenario fixtures**: `HAPPY_PATH`, `LIAR` (claims success while changing nothing — "the single most important fixture", exercising axiom A3), `SCOPE_CREEP` (edits outside allowed scope), `CORRECTION` (fails review once then fixes), `QUESTION` (raises an open question), `ASSUMER` (admits a guess, violating rule R1), `TIMEOUT` (goes silent, exercising the no-progress/timeout detector), `CRASH` (dies mid-step), `AUTH_FAILURE`, `READ_ONLY` (no write capability), `TEXT_REPLY` (fenced report as raw prose, the real-CLI path), `NO_REPORT` (prose with no report block, needs re-prompt), `MALFORMED_TWICE` (exhausts the single retry), `NO_PROGRESS` (8 steps, all identical diffs — proves the no-progress guard fires before the iteration cap), `FULL_RUN` (3 honest turns: plan/implement/review). All bundled into `SCENARIOS` (a const object) and `ScenarioName = keyof typeof SCENARIOS`. Helper `fencedReport(body)` wraps JSON in `FORGE_REPORT_BEGIN`/`FORGE_REPORT_END` sentinels as a real CLI would print.

**Calls/depends on:** `zod`, `@shared/domain` (`agentReportSchema`, `capabilitySchema`, types).

**Called from/used by:** `mockRuntime.ts` (type `Scenario` only, structurally), and directly by `src/main/acceptance/mvpAcceptance.test.ts`, `bindings/bindings.test.ts`, `evidence/reconciliation.integration.test.ts`, `evidence/verifier.test.ts`, `src/main/index.ts`, `workflows/workflowService.test.ts`.

---

### `src/main/runtimes/mockRuntime.ts`

**Purpose:** A fully scripted, deterministic `IAgentRuntime` implementation driven by a `Scenario` — lets the whole engine be built/tested with no real agent process.

**What it does:** `MockAgentRuntime implements IAgentRuntime`. Two properties matter: (1) it **genuinely mutates the worktree** on `edits` (via `applyEdit`, writing/removing files), so the `LIAR` scenario's dishonesty is measurable against real disk state; (2) it is fully deterministic — no timers/randomness/wall-clock, using an injectable `now()` clock (defaults to `fixedClock()`, a fixed UTC origin advancing one second per call). `start(options)` creates a `SessionHandle` and initial `SessionState` (queues an initial `idle` event). `send(session, packet)` consumes the next scripted `ScenarioStep` in order (throws if scenario is exhausted or session is already terminal); emits `state:working`, then narration as `chunk` events, then `tools`, applies file edits, then branches on `step.ending`: `report` → emits `result` + `state:completed`; `text` → emits raw `chunk` text + `state:idle` (exercises the parsing path); `silent` → emits nothing further, leaving state `working` (what the no-progress/timeout detector must catch); `crash` → retryable error + `state:failed`; `providerLimit` → non-retryable error flagged `providerLimit:true`; `authFailure` → non-retryable, `providerLimit:false`. `events(session)` is an async generator draining a `pending` queue with a promise-based "wake" mechanism to avoid busy-polling and lost wakeups (careful ordering: sets `wake` in the same synchronous turn as checking the queue, to avoid a race where an `emit` between check and `await` would be lost). `status`, `cancel` (no-op if already terminal), `dispose` (idempotent) round out the interface.

**Calls/depends on:** `node:fs/promises` (`mkdir`, `rm`, `writeFile`), `node:path`, `@shared/domain` (schemas/types), `./scenario` (`Scenario` type).

**Called from/used by:** `src/main/acceptance/mvpAcceptance.test.ts`, `bindings/bindings.test.ts`, `evidence/reconciliation.integration.test.ts`, `src/main/index.ts`, `workflows/workflowService.test.ts`. Re-exported from `runtimes/index.ts`.

---

### `src/main/runtimes/exchange.ts`

**Purpose:** One request/response "turn" with any agent runtime, including the protocol's single re-prompt-on-malformed-reply retry — the shared logic every adapter's raw event stream flows through before becoming a validated `AgentReport`.

**What it does:** `collectTurn(events, onEvent)` — drains an `AsyncIterator<RuntimeEvent>` until a turn boundary: a `result` event (already-structured report, used by the mock), an `error` event, or a terminal/`idle` `state` event (an `idle` only ends a turn once `working` has actually been observed — otherwise a session's own start-up `idle` event would cut turn one short). Every event is forwarded to `onEvent` (uncaught — a throwing observer is treated as a caller bug and not swallowed) before being interpreted, so a live view sees the turn as it happens (#152). `exchange(runtime, session, packet, onEvent?)`: the main export. Internal `attempt(prompt, correction)` sends (with the correction, if any, attached via `packet.correction`, not string-concatenated — a #135 fix), collects the turn, and on success returns an `ExchangeOutcome`; on a `text` reply it calls `parseAgentReport(turn.text)` and, if that fails with `no-report`, attempts a **resilient JSON-block fallback extraction** via regex (looks for fenced ```json blocks or a bare `{"status":...}` object) — a notably permissive best-effort recovery path. If still unparsed and this is the retry, and there is substantive non-empty text, it **synthesizes** a `completed` report from the raw text rather than failing outright. Only after exhausting both attempts does it return a `protocol` failure. Exactly one retry is enforced by structure (`first`/`second` calls, no loop). `correctionNotice(error)` builds the re-prompt text repeating the fence sentinels.

**Calls/depends on:** `@shared/domain` (`assessReport`, `parseAgentReport`, `renderPromptPacket`, `REPORT_BEGIN`/`REPORT_END`, types).

**Called from/used by:** `src/main/runtimes/orchestrator.ts` only (confirmed via grep — no other consumer found).

---

### `src/main/runtimes/interactiveTurn.ts`

**Purpose:** Pure, screen-scraping-free (well — screen-*reading*) rules for driving a hosted interactive CLI: knowing when its prompt is ready, when a turn has finished, and how to safely deliver a prompt via keystrokes.

**What it does:** All pure functions over a `screen: string` (rendered terminal text), so they're testable against recorded fixtures without spawning anything. `isPromptReady(screen)` — regex `/❯|▶▶|for shortcuts|Try "/`, keyed on the prompt **caret**, not hint text (measured to differ under `--dangerously-skip-permissions`). `blockingPrompt(screen)` — detects the CLI's two known human-only dialogs: `'trust'` (safety-check dialog) or `'permission'` ("Do you want to proceed?"). `turnLooksComplete(screen)` — false while a busy indicator (`esc to interrupt|Cooking|Searching for|Thinking|Cogitating`, present-tense only) is visible, else defers to `isPromptReady`; deliberately conservative (a false positive would truncate an agent mid-thought). `promptKeystrokes(prompt)` — returns the keystroke sequence to send: flattens newlines to spaces (a real newline would submit early), wraps the text in bracketed-paste escape markers `\x1b[200~...\x1b[201~` (required — measured that an unwrapped >1200-char prompt arrived truncated to only its tail) with a 1200ms pause, then a bare `\r` to submit.

**Calls/depends on:** Nothing (pure, zero imports).

**Called from/used by:** `hostedSession.ts` (`blockingPrompt`, `isPromptReady`, `promptKeystrokes`, `turnLooksComplete`), `hostedClaudeRuntime.ts` (`blockingPrompt`, `promptKeystrokes`).

---

### `src/main/runtimes/hostedSession.ts`

**Purpose:** Wraps one hosted (long-lived, interactive) CLI process with a headless `xterm` terminal emulator, so its screen can be reliably read rather than regex-matched over raw ANSI bytes.

**What it does:** `HostedSession` class wraps an `@xterm/headless` `Terminal`. `receive(data)` feeds output into the emulator, **awaited** (write is async/callback-based — a synchronous read right after would see a blank screen; this was measured as a real bug). `screen()` — full scrollback. `visible()` — only currently-displayed rows (`baseY` onward) — required for busy-indicator checks, since scrollback keeps old "esc to interrupt" text forever and would falsely never let a second turn complete. `waitForPrompt()` — polls `visible()` via `pollUntil`, returning `'ready'`/`'trust'`/`'permission'`/`'timeout'`. `waitForBootSettled(quietMs=1500)` — after the prompt first appears, waits for the screen to stop changing for `quietMs` (measured: boot noise — MCP auth warnings, hook output, plugin banners — keeps painting for seconds after the caret appears; a prompt sent too early gets answered against that noise instead of the task). Ticks in fixed `pollMs=250` increments rather than wall-clock `Date.now()`, so an injected fake `sleep` in tests scales correctly. `runTurn(prompt)` — sends `promptKeystrokes`, then polls until `turnLooksComplete` **and** the screen has changed from what was on screen at submission time (`sawWork` flag) — guards against the same idle box being mistaken for "already done" on the very first poll. Returns `{ kind: 'answered'|'blocked'|'timeout', screen }`. Private `pollUntil(check)` — bounded loop, 250ms ticks, throwing `'timeout'` past the deadline rather than hanging forever.

**Calls/depends on:** `@xterm/headless`, `./interactiveTurn` (`blockingPrompt`, `isPromptReady`, `promptKeystrokes`, `turnLooksComplete`).

**Called from/used by:** `hostedClaudeRuntime.ts` only (no other direct consumer found via grep).

---

### `src/main/runtimes/hostedClaudeRuntime.ts`

**Purpose:** A second Claude CLI adapter registered alongside `ClaudeCliRuntime` — hosts the CLI as a real persistent interactive pty session instead of spawning headless once per turn, trading cold-start cost (~130s measured) for a warm session (~8s per turn measured).

**What it does:** `HostedClaudeRuntime implements IAgentRuntime`, id `'claude-cli-hosted'`, `instructionFilenames: []` (unlike the headless adapter's `['CLAUDE.md']` — this one runs unmodified, so the CLI loads its own `CLAUDE.md`; declaring it too would duplicate instructions). `start(options)`: requires an injected `ProcessManager` (throws otherwise — A2/A3, no silent fabricated success); optionally installs a `ClaudeHookBridge` **before** spawning (so even the first turn reports through the `Stop` hook); spawns the CLI via `processes.spawn` on a pty (120×30); wraps it in a `HostedSession`; subscribes to **raw** (not ANSI-stripped) process output, feeding the emulator — because a redacted stream can never resolve a real screen (measured: 240s timeout vs 8s with raw); publishes `onProcess` (`write`/`resize`) so a pane can attach to the real process. `send(sessionHandle, packet)`: on the very first turn only, calls `waitForBootSettled()`; waits for `waitForPrompt()`, failing (retryable) if it lands on a dialog or times out; if hooks are installed, delegates to `runTurnByHook`; otherwise falls back to the unreliable screen-only `hosted.runTurn`. `runTurnByHook(session, hooks, packet)`: types the prompt via `promptKeystrokes`, then **races** three promises — `hooks.next()` (the `Stop` hook log-file signal), `watchForDialog(session)` (polls the live screen for a mid-turn blocking dialog every 500ms), and a timeout — the winner decides the outcome; on a hook win, emits the `lastAssistantMessage` verbatim as one `chunk` event (never duplicated with raw stream text) then `state:completed`. `watchForDialog` stops polling once `session.dialogWatchCancelled` is set (avoids a losing race arm reporting a stale/next-turn's dialog). `argsFor(options)` builds argv with `--session-id`/`--resume` (via `claudeSessionId`) and permission flags (no `-p`, no `--output-format`, no `--safe-mode` — this is the true interactive CLI). `cancel`/`dispose` kill the process (a hosted session never exits on its own).

**Calls/depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (types/schemas), `../process/processManager` (`ProcessHandle`, `ProcessManager`), `./claudeHooks` (`ClaudeHookBridge`), `./claudeSession` (`claudeSessionId`), `./hostedSession` (`HostedSession`), `./interactiveTurn` (`blockingPrompt`, `promptKeystrokes`).

**Called from/used by:** `src/main/index.ts` only.

---

### `src/main/runtimes/claudeHooks.ts`

**Purpose:** Learns exactly when a hosted Claude CLI turn ends (and what it said) from the CLI's own `Stop` lifecycle hook, rather than any screen-reading heuristic — all four screen-only heuristics tried were measurably wrong (see doc comment referencing `docs/CLI-FIELD-GUIDE.md` §9).

**What it does:** `ClaudeHookBridge` class, constructed per-worktree. `install()`: writes a minimal receiver script (`RECEIVER_SOURCE`, a literal string — deliberately a real file rather than an inline `-e` string, since two inline attempts both broke on shell quoting) to `receiverDir/forge-hook-receiver.cjs`; truncates/creates a `.claude/forge-hooks.jsonl` log file; **merges** (read-modify-write, never blind-replaces) Forge's own `Stop` and `PermissionRequest` hook entries into `.claude/settings.local.json`, tagging its own entries with a `FORGE_HOOK_MARKER` string inside the command so `uninstall()` can remove exactly those and nothing the user configured; writes via temp-file+`rename` for atomicity. `next()`: resolves the next hook event — first checks for already-appended lines, else `fs.watch`s the log file (an append is one atomic write, so `change` fires reliably). `close()` stops watching. Private `readNewLines()` tracks a byte offset into the log to only consume new content. `parseHookLine(line)` unwraps the receiver's `{kind, at, raw}` wrapper and extracts `session_id`, `last_assistant_message`, `tool_name` from the inner CLI hook payload — other fields are deliberately left unmodeled.

**Calls/depends on:** `node:fs/promises` (`readFile`, `rename`, `writeFile`, `mkdir`), `node:fs` (`watch`, `FSWatcher`), `node:path`.

**Called from/used by:** `hostedClaudeRuntime.ts` only (`ClaudeHookBridge`).

---

### `src/main/runtimes/claudeSession.ts`

**Purpose:** Derives a stable, reproducible `--session-id` for the Claude CLI from a Forge step's own identity, so a step maps deterministically to the same CLI session (survives Forge restarts) and a correction retry gets a genuinely new conversation.

**What it does:** `claudeSessionId({ workflowId, stepIndex, iteration })` — builds a name string `${workflowId}/${stepIndex}/${iteration}` and computes a v5-style UUID via SHA-1 (`uuidV5`) against a fixed namespace constant `FORGE_SESSION_NAMESPACE`, so two installations working on the same workflow id don't collide. Including `iteration` is deliberate: a correction retry must not resume into the transcript that produced the rejected report. `uuidV5(namespace, name)` implements RFC 4122 v5 by hand (SHA-1 over namespace bytes + name), setting the version nibble (byte 6) and variant bits (byte 8) manually — done in-house rather than via a dependency since `node:crypto` has `randomUUID` but no name-based variant.

**Calls/depends on:** `node:crypto` (`createHash`).

**Called from/used by:** `claudeCliRuntime.ts`, `hostedClaudeRuntime.ts` (both call `claudeSessionId` to build `--session-id`/`--resume` args).

---

### `src/main/runtimes/claudeStream.ts`

**Purpose:** Pure parser for the Claude CLI's `--output-format stream-json` NDJSON transport — reduces each line to typed observations Forge acts on, without interpreting provider-specific prose (axiom A6 — this file names a provider's wire format and so lives here, never in `shared/`).

**What it does:** `StreamObservation` interface: `tools` (invocations in order), `text` (assistant prose, display-only — **never** used to parse a report, since streamed text plus the final reply would duplicate the report block), `result` (only on the terminal line: `{text, isError, sessionId}`), `usage` (`costUsd`, `inputTokens`, `outputTokens`), `providerLimitReached` (boolean). `takeCompleteLines(buffer)`: splits a stdout chunk into complete lines plus an incomplete tail (a read boundary falls anywhere, so naive per-chunk parsing would lose fragmented terminal `result` lines). `observeStreamLine(line)`: parses one NDJSON line, dispatching on `message.type`: `'assistant'` → `observeAssistant` (extracts `text` and `tool_use` blocks, truncating tool input display to 300 chars), `'rate_limit_event'` → `observeRateLimit` (only flags `providerLimitReached` when **both** `status` and `overageStatus` are non-`allowed` — measured that a request served from overage after the primary window exhausted is still a *success*, not a spent account, and an earlier version wrongly halted a healthy run on this), `'result'` → `observeResult` (terminal envelope). `system`/`user`/unknown types return `EMPTY`. `readUsage(raw, costUsd?)` normalizes token counts, returning `null` if nothing was reported (never fabricating zeros, which would be indexed as a real measurement).

**Calls/depends on:** Nothing external (pure).

**Called from/used by:** `claudeCliRuntime.ts` (`observeStreamLine`, `takeCompleteLines`), `antigravityCliRuntime.ts` (`takeCompleteLines` only — shares the line-splitting utility but has its own line-observer, `antigravityStream.ts`).

---

### `src/main/runtimes/claudeTrust.ts`

**Purpose:** Pre-empts the Claude CLI's one-time-per-directory "do you trust this folder?" safety dialog before launch, since every Forge worktree is a fresh path and the dialog would otherwise fire (and hang an unattended run) on **every** run.

**What it does:** `ClaudeTrustStore` class, reading/writing `~/.claude.json` (or an injected `configPath` for tests). `trust(workspacePath)`: read-modify-write (never blind-overwrite — this file holds many other projects' state plus onboarding flags, caches, OAuth account) that sets `projects[normalisePath(workspacePath)].hasTrustDialogAccepted = true`, preserving every other key; written to a temp file then `rename`d for atomicity; returns `false` (non-fatal) if the config can't be read/parsed, rather than throwing — the caller can still launch and a human answers the dialog once. `normalisePath(value)` converts backslashes to forward slashes, since the CLI's own config keys use forward slashes even on Windows — a mismatched key form would silently fail to suppress the dialog.

**Calls/depends on:** `node:fs/promises` (`readFile`, `writeFile`, `rename`), `node:os` (`homedir`), `node:path`.

**Called from/used by:** `src/main/workflows/workflowService.ts` only.

---

### `src/main/runtimes/claudeCliRuntime.ts`

**Purpose:** The primary, production Claude CLI adapter (`claude`), driven **headlessly** (`-p` one-shot per turn) via stdin/stdout pipes — implements `IAgentRuntime`.

**What it does:** Exports the `ProcessRunner` type (shared with `antigravityCliRuntime.ts`) — a function `(command, args, options) => Promise<ProcessRunnerResult>` abstracting how a process is actually spawned (`options.onProcess` publishes a `write`/`resize` handle for pane attachment; `options.stdin` carries the prompt — **never** as an argv argument, since a multi-line prompt through `-p` on Windows arrived empty (#131)). `ClaudeCliRuntime implements IAgentRuntime`, id `'claude-cli'`, `simulated: false`, `supportsAccountIsolation: true` (credential lives at `~/.claude/.credentials.json`, so a distinct `HOME` isolates accounts — #111), `instructionFilenames: ['CLAUDE.md']`. Constructor takes optional `executablePath`, `runner` (a `ProcessRunner`), `now`, and `homeForAccount(accountId) => string|null` (injected resolver from account id to isolated home dir). `start(options)` just registers session state. `send(sessionHandle, packet)`: **throws loudly** (via a `failed` state + `error` event, not silently) if no `runner` is configured or if `session.options.accountId` names an account with no enrolled home — axiom A2/A3, fabricated success is unacceptable in Forge's own adapter. Otherwise delegates to `executeWithRunner`. `executeWithRunner`: builds argv `['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', ...optional --session-id via claudeSessionId, ...claudePermissionArgs(mode)]`; runs the process with `stdin: promptText`, optional `env: accountEnv(accountHome)`; in `onStdout`, accumulates raw output (never emitted as a `chunk` directly — would duplicate the escaped envelope copy and the unwrapped reply, causing a real historical bug #130) while also feeding `takeCompleteLines`/`observeStreamLine` to emit `tool` events live and detect `providerLimitReached`; `onStderr` emits `chunk` events. After the process exits: checks `stream.limitReached` first (halts with `providerLimit:true`, non-retryable); then empty-output+nonzero-exit (retryable failure); then unwraps the reply via `extractResultText`/`findTerminalResult` (scans NDJSON lines **from the end** for a `result` line, since the reply is the CLI's last write) falling back to raw stdout; emits it as one `chunk`; extracts `usage` (`extractUsage`, also scanning the terminal result) and emits a `usage` event; finally emits `state:completed` — leaving the actual report parsing to `exchange()`, deliberately not duplicated here. `claudePermissionArgs(mode)`: `bypassPermissions` → `--dangerously-skip-permissions`; else `--permission-mode <mode>` passed through.

**Calls/depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (`DEFAULT_PERMISSION_MODE`, `renderPromptPacket`, `runtimeIdSchema`, `sessionIdSchema`, types), `../accounts/accountAuth` (`accountEnv`), `./claudeSession` (`claudeSessionId`), `./claudeStream` (`observeStreamLine`, `takeCompleteLines`).

**Called from/used by:** `src/main/acceptance/dogfood.manual.test.ts`, `src/main/accounts/enrollmentService.test.ts`, `src/main/index.ts`. (`ProcessRunner`/`ProcessRunnerResult` types also imported by `pipeProcessRunner.ts`, `ptyProcessRunner.ts`, `antigravityCliRuntime.ts`.)

---

### `src/main/runtimes/antigravityCliRuntime.ts`

**Purpose:** Adapter for the Antigravity CLI (`agy`), mapped to `IAgentRuntime` — structurally similar to `ClaudeCliRuntime` but with entirely distinct, independently-measured CLI flags and wire format (axiom A6: kept as a wholly separate module rather than sharing logic).

**What it does:** `AntigravityCliRuntime implements IAgentRuntime`, id `'antigravity-cli'`, `supportsAccountIsolation: false` (credential lives in the Windows Credential Manager under one fixed target name — not filesystem-based — so concurrent sessions share one account, unlike Claude), `instructionFilenames: ['AGENTS.md', 'CLAUDE.md']` (both listed even though it's unmeasured which the CLI itself would read — Forge injects the file content into the packet regardless). `start`/`send` mirror the Claude adapter's structure. `argsFor(session, promptText)`: `-p=<prompt>` **attached** (Go-style flag, not a separate argv element — passing separately makes `agy` swallow the real prompt as the next flag's value); `--output-format=stream-json`; `--add-dir=<repositoryPath>` (**required** — its absence is called out as the worst failure mode found in either adapter: `agy` reports `SUCCESS` while editing a directory it invented, cwd alone doesn't establish the workspace); permission mode tested by exclusion (`mode !== 'plan'` means "may write", not equality against `acceptEdits` — an earlier equality check silently withheld write permission once the orchestrator started sending `bypassPermissions`, #173) mapping to `--dangerously-skip-permissions` or `--mode=plan`. In `executeWithRunner`'s `onStdout`, feeds `takeCompleteLines` + `observeAntigravityLine`, watching for `refusedBeforeStarting` (a measured, intermittent pre-flight eligibility check failure — "failed to get profile picture" — reported as **retryable** and explicitly not the agent's fault, since the CLI never reached the model). Unwraps the reply via `extractResponseText` (agy's envelope shape `{response, status, conversation_id, usage}` is unrelated to Claude's `{result, is_error}` — deliberately not shared code) and usage via `observeAntigravityLine(lastResultLine(...))`. `agy` reports no cost figure — `costUsd` stays `null` rather than derived (never estimating, per A3).

**Calls/depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (types/schemas), `./claudeCliRuntime` (`ProcessRunner` type only — shared spawner abstraction), `./antigravityStream` (`observeAntigravityLine`), `./claudeStream` (`takeCompleteLines` only).

**Called from/used by:** `src/main/acceptance/dogfood.manual.test.ts`, `src/main/accounts/enrollmentService.test.ts`, `src/main/index.ts`.

---

### `src/main/runtimes/antigravityStream.ts`

**Purpose:** Pure parser for the Antigravity CLI's `--output-format=stream-json` NDJSON transport — the Antigravity-specific counterpart to `claudeStream.ts`, deliberately not unified with it since the two CLIs' wire shapes share nothing.

**What it does:** `AntigravityObservation` interface: `tools`, `result` (`{text, isError, conversationId, refusedBeforeStarting}`), `usage`. `observeAntigravityLine(line)` dispatches on `message.event`: `'step_update'` → `observeStepUpdate` (reports a tool only on its `ACTIVE` state transition — not `DONE` — so the timeline shows one row per invocation, at start rather than after; truncates tool parameter display to 300 chars; also threads `usage` through from every step, since `agent_response` steps carry usage but no text), `'result'` → `observeResult` (computes `isError` from `status !== 'SUCCESS'`; computes `refusedBeforeStarting = isError && num_turns === 0` — the signature of the CLI never reaching the model at all), `'init'`/unknown → ignored (the CLI's whole tool inventory/CWD, useful for a spike but noise for a live view). `readUsage(raw)`: extracts `input_tokens`/`output_tokens`; `costUsd` is always `null` (agy reports no cost); notes `thinking_tokens`/`cache_read_tokens` have no field mapped yet (a known omission, not folded into `outputTokens` to avoid overstating it).

**Calls/depends on:** Nothing external (pure).

**Called from/used by:** `antigravityCliRuntime.ts` only.

---

### `src/main/runtimes/pipeProcessRunner.ts`

**Purpose:** A `ProcessRunner` implementation over plain OS pipes (stdin/stdout/stderr), required specifically because a **pty** cannot deliver piped stdin to a child that demands it — the child sees a TTY and takes the interactive path instead (measured, #131).

**What it does:** `createPipeProcessRunner(options: { idleTimeoutMs?, hardTimeoutMs?, orphans?: OrphanTracker })` returns a `ProcessRunner`. Resolves the executable via `resolveCommand` (PATH/PATHEXT search — `CreateProcess` doesn't search PATH on Windows) and spawns via `shell: true` **only** for `.cmd`/`.bat` shims (a batch file needs a shell to interpret; anything else spawned directly to avoid `shell:true` re-parsing a path containing spaces). Records the pid with an `OrphanTracker` (so a crashed Forge doesn't leave the agent process running). Publishes `onProcess({})` — empty, since a pipe supports neither `write` nor `resize` (no window size, stdin closed after the prompt) — a caller should show "cannot take input" rather than accept dead-end text. Implements both an **idle timeout** (resets on any stdout/stderr data) and a **hard timeout** (absolute ceiling), plus `AbortSignal` cancellation, all funneling into a single `finish(reason)` that calls `child.kill()` with **no signal argument** (Windows has no POSIX signals; passing one throws uncatchably). Redacts output as it arrives (`redactOutput(stripAnsi(chunk))`) before buffering or forwarding to `onStdout`/`onStderr` — never redacting only at the end, since a live log would already have rendered an unredacted secret. Writes `stdin` then **closes** it (the CLI reads until EOF; an unclosed stdin means the run hangs to the idle timeout). On exit, the **kill reason is authoritative over the exit code** — a killed process may report `null` or `0` depending on platform, and trusting the code would misreport a timeout/cancellation as a clean exit.

**Calls/depends on:** `node:child_process` (`spawn`), `../process/orphans` (`OrphanTracker` type), `../process/processManager` (`resolveCommand`), `../process/redact` (`buildChildEnv`, `redactOutput`, `stripAnsi`), `./claudeCliRuntime` (`ProcessRunner` type).

**Called from/used by:** `src/main/acceptance/dogfood.manual.test.ts`, `src/main/index.ts`.

---

### `src/main/runtimes/ptyProcessRunner.ts`

**Purpose:** A `ProcessRunner` implementation backed by the real pty (`ProcessManager`), so an adapter can drive an actual CLI over a pseudo-terminal — used where the caller needs a real terminal (as opposed to piped stdin, which the pty runner explicitly cannot deliver).

**What it does:** `createPtyProcessRunner({ processes: ProcessManager, idleTimeoutMs?, hardTimeoutMs? })` returns a `ProcessRunner`. Thin adaptation of the `ProcessRunner` shape onto `ProcessManager.spawn`: `handle.onData` → `onStdout`; `outcome.exitCode` → `exitCode`; `signal` abort → `handle.cancel()`. Publishes `onProcess({write, resize})` **before any output is consumed**, so an attaching pane doesn't miss the first frames (#170). If `runOptions.stdin !== undefined` it **throws** — a pty cannot carry stdin to a child requiring piped input (measured — the CLI answers "Input must be provided either through stdin or as a prompt argument" regardless), so callers needing stdin must use `pipeProcessRunner` instead. Cancellation is routed through `handle.cancel()` rather than by rejecting the returned promise — so the process is actually killed rather than merely abandoned by the caller. Exit code: like the pipe runner, **the outcome's `reason` is authoritative over the reported exit code** (a killed pty reports inconsistent codes cross-platform — measured 0 on Linux CI for a timeout). Honestly documents that **stderr cannot be separated from stdout** on a pty (a single stream by construction) — `onStderr` is simply never called, and the returned `stderr` field is populated only with the failure reason string, not real stderr bytes.

**Calls/depends on:** `../process/processManager` (`ProcessManager` type), `./claudeCliRuntime` (`ProcessRunner` type).

**Called from/used by:** No direct external consumer found via grep in this pass (likely wired up in `src/main/index.ts`'s runtime construction alongside the pipe runner, or reserved/partially unused — worth double-checking at refactor time since `pipeProcessRunner` is what's actually referenced by `index.ts` and `claudeCliRuntime`/`antigravityCliRuntime` take a generic `ProcessRunner`).

---

## `src/main/git/`

### `src/main/git/index.ts`

**Purpose:** Public barrel for the git module.

**What it does:** Re-exports `GitCommandError`, `GitExecOptions` (from `exec.ts`); `DirtyWorktreeError`, `GitService`, `NotARepositoryError`, `DiffOptions`, `DiffResult`, `GitServiceOptions`, `Snapshot` (from `gitService.ts`); `joinDiffFiles`, `parseNameStatus`, `parseNumstat`, `parseStatus`, `DiffFile`, `StatusEntry`, `StatusResult` (from `parse.ts`); `WorktreeService`, `PreparedWorktree`, `WorktreeServiceOptions` (from `worktreeService.ts`). Note: `DefaultBranch` type from `gitService.ts` is **not** re-exported here — a gap worth checking if any consumer needs it directly.

**Calls/depends on:** `exec.ts`, `gitService.ts`, `parse.ts`, `worktreeService.ts`.

**Called from/used by:** `src/main/changesets/changeSetService.ts`, `src/main/evidence/changeSetBuilder.ts`, `src/main/evidence/reconciliation.integration.test.ts`, `src/main/projects/validateRepository.ts`, `src/main/runtimes/guards.integration.test.ts`, `src/main/runtimes/orchestrator.test.ts`, `src/main/runtimes/runtimes.test.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/main/git/exec.ts`

**Purpose:** The single choke point through which Forge ever invokes the `git` binary — centralizes safety (no shell, sanitized env) and byte-accurate output handling.

**What it does:** `GitCommandError` — carries `args`, `exitCode`, `stderr`, and (crucially) `stdout` too, since a non-zero exit doesn't always mean no useful output (`diff --no-index` exits 1 whenever files differ, with the diff itself on stdout). `runGit(args, options: GitExecOptions)`: wraps `execFile('git', [...GLOBAL_ARGS, ...args], {...})` in a Promise — **`execFile`, never `exec`**, so no shell parses the arguments (a branch name or path containing `;`/`&&`/quotes is just an argument, never injectable syntax). `GLOBAL_ARGS` prepended to every call: `-c core.quotepath=false` (load-bearing — otherwise git escapes non-ASCII path bytes as octal, breaking path comparisons), `-c core.pager=cat` (a user's pager/diff.external/textconv must not rewrite what Forge sees), `--no-optional-locks`. Encoding is `latin1` (byte-preserving) rather than `utf8` — because `-z`-terminated records are split on raw NUL bytes first, and each field is only decoded to UTF-8 afterward (via `decodeField`) so a multi-byte path survives the split intact. Env forces `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. `maxBuffer` defaults to 64MB (generous — silent truncation of a diff would be silent corruption of evidence) and `timeoutMs` defaults to 60s. `decodeField(field)` — latin1→utf8 conversion for one `-z` field. `splitNul(stdout)` — splits on `\0`, dropping the trailing empty element git's `-z` termination style produces.

**Calls/depends on:** `node:child_process` (`execFile`).

**Called from/used by:** `src/main/projects/validateRepository.ts` (direct file import); `gitService.ts` and `worktreeService.ts` internally; re-exported via `git/index.ts` to all the consumers listed there.

---

### `src/main/git/parse.ts`

**Purpose:** Pure parsers for git's machine-readable output formats (`--name-status -z`, `--numstat -z`, `--porcelain=v2 -z` status) — kept pure and separate from process-spawning so awkward edge cases (renames, binary files, unicode paths) are unit-testable against captured output.

**What it does:** `changeTypeFromLetter(letter)` maps git's status letters to the domain `ChangeType` (`A`→added, `M`/`T`→modified, `D`→deleted, `R`→renamed, `C`→**added**, since the domain has no "copied" case — a copy is genuinely new content from review's perspective; unknown letters like `U` (unmerged) return `null` rather than guessing, per axiom A2). `isRenameOrCopy(code)` — codes starting `R`/`C` (which carry a similarity score suffix like `R075`). `parseNameStatus(records)`: variable-arity parser — a rename/copy record consumes 3 fields (code, from, to), everything else consumes 2 (code, path); unparseable entries are dropped rather than fabricated. `parseNumstat(records)`: parses tab-delimited `insertions\tdeletions\tpath` records; a binary file reports `-`/`-` which becomes `0`/`0` with a `binary: true` flag (kept so callers can distinguish "changed but binary" from "unchanged", rather than losing that distinction); an empty inline path signals a rename/copy whose two paths follow as separate records. `joinDiffFiles(nameStatus, numstat)`: joins the two parses on the **new** path (neither format alone carries both change-type and line-counts) — a file present in name-status but missing from numstat (rare) keeps zeroed counts rather than being dropped. `parseStatus(records)`: parses `git status --porcelain=v2 --branch -z` — handles `# branch.head`/`# branch.oid` header lines (`(detached)`→`null` branch, `(initial)`→`null` headSha for an empty repo), `?`/`!` (untracked/ignored), `u` (unmerged/conflicted, extracting the path from a fixed-position field split), and `1`/`2` (ordinary/renamed entries — v2 reverses path order vs. diff: new path inline, old path in the following record). The **staged** letter takes precedence for the reported `changeType` when both staged and unstaged differ from `.`, since a changeset is diffed against HEAD.

**Calls/depends on:** `@shared/domain` (`ChangedFile`, `ChangeType` types), `./exec` (`decodeField`).

**Called from/used by:** `gitService.ts` internally (`joinDiffFiles`, `parseNameStatus`, `parseNumstat`, `parseStatus`); re-exported via `git/index.ts`.

---

### `src/main/git/gitService.ts`

**Purpose:** Read-only access to a git repository — the primary evidence source for axiom A3 (an agent's claim about what it changed is checked against what this service actually reports). Deliberately has **no mutating methods** (no commit/branch/stage/push) — that boundary is enforced by omission, not by a runtime check.

**What it does:** `sameDirectory(left, right)` — compares two paths by `stat().dev`+`.ino` (filesystem identity) rather than string equality, because Windows has multiple valid spellings for one directory (short 8.3 names, case-insensitivity, junctions) — `realpath` alone doesn't normalize short names, which is exactly what failed on Windows CI. Falls back to normalized-string comparison only when one path doesn't exist yet. `NotARepositoryError`, `DirtyWorktreeError` (carries `changedPaths`, capped display to 5). `GitService` class, constructed with `{ repositoryPath, timeoutMs?, maxBuffer? }`. Key methods:
- `isRepo()` — `rev-parse --show-toplevel` then confirms via `sameDirectory` that the reported root *is* the configured path (requires the root specifically, not a subdirectory, else path-relativity would silently mismatch).
- `currentBranch()`, `listBranches()` (sorted by `refname` explicitly — git's own default sort order isn't stable across versions, and this list is user-facing).
- `defaultBranch()`: resolution order `origin/HEAD` (via `remoteDefaultBranch`) → `init.defaultBranch` config (only if that branch actually exists locally) → `main`/`master` by convention → `null` (a real "unknown" answer per A2, not a guess). Returns `{name, source: 'origin-head'|'config'|'convention'}` — the source travels with the name because the rules differ in trustworthiness and the UI must present them differently (#140). This directly fixes the #100 defect where a project bound while on a feature branch recorded that branch as its "default."
- `headSha()` — `null` for an unborn HEAD (no commits yet) rather than throwing, since a fresh repo is a legitimate project to bind.
- `status()` — wraps `parseStatus`. `isDirty()` — true if any entries/untracked/conflicted exist.
- `snapshot({allowDirty=false})` — refuses (throws `DirtyWorktreeError`) unless the tree is clean or `allowDirty` is explicitly set (prevents attributing pre-existing changes to the step about to run); returns `{sha, branch, capturedAt}`.
- `diff(base, head, options)` — commit-to-commit diff via `collectDiff`.
- `diffWorktree(base, options)` — diffs the **working tree** (staged+unstaged+untracked) against a base; combines `collectDiff([base])` (tracked changes) with `collectUntracked(status.untracked)` (untracked files diffed with `--no-index` against the null device, since `git diff <base>` alone is blind to untracked files — the single most common kind of agent-created change; caught by a test, not review). Deliberately avoids `git add -N` (would mutate the index of a repo an agent may be actively using).
- `collectDiff(revArgs, options)` — runs `--name-status -z`, `--numstat -z`, `--patch --no-color` **in parallel** (`Promise.all`), joins via `joinDiffFiles`.
- `fileAtRev(rev, path)` — `git show <rev>:<path>`, returning `null` (not throwing) for a path absent at that revision — used to detect "this file was added by the change" without ever checking anything out (which would mutate the worktree).
- `changedFiles(base, head?)` — structured file list without the patch text (cheaper for scope enforcement, #34).
- `listWorktreeFiles()` — `ls-files --cached --others --exclude-standard -z`, so `.gitignore` is honored by git itself rather than a reimplemented matcher; de-duplicates (a path can appear as both tracked-and-modified) and sorts by codepoint (not locale, for cross-machine reproducibility).
- `readFileInWorktree(path)` / `writeFileInWorktree(path, content)` — the **only** mutating-adjacent methods (a direct filesystem write, not a git operation) — used for the "user edit mode" feature; both validate `path` through `repoPathSchema` first.

**Calls/depends on:** `node:fs/promises` (`readFile`, `stat`, `writeFile`), `node:path` (`resolve`), `@shared/domain` (`repoPathSchema`, `shaSchema`, types), `./exec` (`GitCommandError`, `runGit`, `splitNul`, `GitExecOptions`), `./parse` (`joinDiffFiles`, `parseNameStatus`, `parseNumstat`, `parseStatus`, types).

**Called from/used by:** Via `git/index.ts` barrel: `changesets/changeSetService.ts`, `evidence/changeSetBuilder.ts`, `evidence/reconciliation.integration.test.ts`, `projects/validateRepository.ts`, `runtimes/guards.integration.test.ts`, `runtimes/orchestrator.test.ts`, `runtimes/runtimes.test.ts`, `workflows/workflowService.ts`.

---

### `src/main/git/worktreeService.ts`

**Purpose:** Creates and disposes disposable, detached git worktrees per-workflow so agents never touch the user's real checkout — closes a real historical vulnerability where agents were spawned directly against `repositoryPath` and wrote files straight into the user's actual repo (measured concretely: a planner wrote two files into a real repo before this existed).

**What it does:** `WorktreeService` constructed with `{ repositoryPath, root }` (root = where all workflow worktrees live, one subdirectory per workflow id). `reclaimAbandoned()`: run at startup; lists existing worktrees (`git worktree list --porcelain`), and for any whose path resolves (via `relative()`, not a naive prefix check, to avoid matching a same-prefixed sibling directory) under this service's own `root`, force-removes it (`git worktree remove --force` then `rm -rf` as a backstop, since `worktree remove` can leave the directory if git considers it already detached) — cleans up after a crash that skipped the `finally`-block disposal. Ends with `git worktree prune`. `prepare(workflowId)`: returns `null` (not throwing) if the repository has no commits yet (`rev-parse --verify HEAD` fails) — the caller must treat `null` as "refuse the run," never silently falling back to the real checkout, which is exactly the behavior this module exists to eliminate. Otherwise removes any stale directory at the target path (idempotent across a crash), then `git worktree add --detach <path> HEAD` — **detached**, deliberately not a named branch (would either collide with an existing user branch or leave a branch behind after cleanup). Returns `{ path, dispose }` where `dispose` is idempotent (`disposed` flag) and force-removes the worktree + directory + prunes.

**Calls/depends on:** `node:fs/promises` (`rm`), `node:path` (`isAbsolute`, `join`, `relative`, `resolve`), `./exec` (`runGit`, `GitCommandError`).

**Called from/used by:** Via `git/index.ts` barrel — `workflows/workflowService.ts` is the primary consumer (constructs worktrees per workflow run); also referenced in the same test files listed above for `gitService.ts` where they exercise the git barrel together.
# Forge — Handoff Document, Part 3: Remaining `src/main/` files (bootstrap, IPC, accounts, audit, bindings, changesets, context, decisions, evidence, health, logging, process, projects, questions, terminal, workflows) + `src/preload/`

## Bootstrap / Security

### `src/main/index.ts`

**Purpose:** The Electron main-process entry point. Wires together every service, store, and runtime, opens the database, creates the app window, and owns application-wide shutdown sequencing.

**What it does:**
- Module-scope singletons `processes: ProcessManager | null` and `database: { db, close } | null` — held at module scope deliberately (per inline comments) because they must outlive any single window and be reachable from quit handlers.
- `startDatabase()` — opens `forge.db` under `app.getPath('userData')` via `initialiseDatabase`. A failure shows a native error dialog (`dialog.showErrorBox`) and calls `app.exit(1)`; returns `null` on failure so the `whenReady` callback bails out early.
- `createWindow()` — constructs the `BrowserWindow` with strict `webPreferences` (contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, etc.), sets platform-specific title bar options (Windows overlay / macOS traffic-light position), pipes renderer console messages to the main process's console, calls `lockWindowNavigation`, and loads either the Vite dev server URL or the packaged `renderer/index.html`.
- Single-instance lock via `claimSingleInstance()`; a `second-instance` handler refocuses the existing window.
- On `app.whenReady()`: opens the DB, applies CSP, denies permission requests, reaps orphaned processes via `OrphanTracker` (constructed pointed at `processes.json`), constructs `ProcessManager`, `AccountHomes`, `RuntimeRegistry`, `AgentSessionRegistry`, registers four runtimes (`MockAgentRuntime` for `mock:default`/scenario `fullRun`, `ClaudeCliRuntime` over a pipe runner, `AntigravityCliRuntime` over a pipe runner, `HostedClaudeRuntime` over the pty-based `ProcessManager`), then builds `ProjectService`, `WorkflowService` (with a late-bound `workflows` closure so `ProjectService`'s `hasRunningWorkflow` predicate can reference it — documented as intentionally one-way to avoid a construction cycle, issue #112), `QuestionService`, `DecisionService`, `ChangeSetService`, `EventStore`/`AccountStore`/`AccountService`, `TerminalService`, then calls `registerIpcHandlers(createIpcHandlers({...}))` and `createWindow()`.
- `emitEvent`/`emitLog`/`emitData`/`emitExit` callbacks broadcast to every non-destroyed `BrowserWindow` via `webContents.send`.
- Shutdown: `before-quit` calls `processes?.killAll(...)` (not awaited, and deliberately not preventing default — comment explains this was measured to avoid a 30s teardown hang); `will-quit` closes the DB handle.
- `window-all-closed` quits unless macOS.

**IMPORTANT — Note added by the session that wrote Part 1 of this handoff:** `HostedClaudeRuntime` is constructed here **without a `hookReceiverDir` option**. This means the hook-driven turn-completion mechanism (issue #169, fully built and verified in isolation) is NOT actually active in the running app as currently wired — the runtime silently falls back to its unreliable screen-scraping `runTurn()` path. Wiring this one option is the single highest-leverage next step for M11.

**Calls / depends on:** `./db` (`initialiseDatabase`), `./ipc/handlers`, `./ipc/register`, `./process` (`OrphanTracker`, `ProcessManager`), `./accounts/accountService`, `./db/accountStore`, `./db/eventStore`, `./changesets/changeSetService`, `./decisions/decisionService`, `./projects/projectService`, `./questions/questionService`, `./workflows/workflowService`, `./runtimes/mockRuntime`, `./runtimes/registry`, `./runtimes/claudeCliRuntime`, `./runtimes/hostedClaudeRuntime`, `./runtimes/antigravityCliRuntime`, `./runtimes/pipeProcessRunner`, `./terminal/sessionRegistry`, `./terminal/terminalService`, `./bindings/bindingService`, `./accounts/accountHomes`, `./accounts/enrollmentService`, `./db/bindingStore`, `./runtimes/scenario`, `./security`.

**Called from / used by:** Nothing (it is the entry point referenced by Electron's `main` field / build config).

---

### `src/main/security.ts`

**Purpose:** Process-level hardening for the renderer, treated as untrusted (per the file's own "axiom A7" comment).

**What it does:**
- `contentSecurityPolicy(devServerUrl)` — builds a CSP string. In dev, adds the Vite dev origin/websocket and `'unsafe-inline'`/`'unsafe-eval'` for HMR; production stays strict with no inline/eval. Blocks `object-src`, `frame-src`, `frame-ancestors`, `base-uri`, `form-action` entirely.
- `applyContentSecurityPolicy(devServerUrl)` — installs the policy on `session.defaultSession.webRequest.onHeadersReceived` for every response.
- `denyAllPermissionRequests()` — sets `setPermissionRequestHandler` to always `callback(false)` and `setPermissionCheckHandler` to always return `false`.
- `lockWindowNavigation(window, allowedOrigin)` — denies `window.open`/target=_blank (routes external `http(s)` URLs to `shell.openExternal` instead), blocks in-page navigation away from `allowedOrigin`, and prevents `will-attach-webview` entirely.
- `isExternalHttp(url)` — private helper, true for `http://` or `https://`.
- `claimSingleInstance()` — thin wrapper around `app.requestSingleInstanceLock()`.

**Calls / depends on:** `electron` (`app`, `shell`, `session`, `BrowserWindow` type) only.

**Called from / used by:** `src/main/index.ts` (all four exports).

---

## IPC

### `src/main/ipc/handlers.ts`

**Purpose:** Implements every IPC channel handler as a plain object (`IpcHandlerMap`), wiring each channel to the relevant service.

**What it does:**
- Exports `IpcDependencies` interface and `createIpcHandlers(deps): IpcHandlerMap`, a factory taking `projects`, `workflows`, `questions`, `decisions`, `changeSets`, `accounts`, `registry`, `bindings`, `enrollment`, `terminal`.
- Internal `buildReport(workflowId)` helper shared by `workflow:exportReport` and `workflow:saveReport` so both surfaces render identical Markdown (via `generateWorkflowReportMarkdown`) — sanitizes the project name into a filename slug and an ISO timestamp with `:`/`.` stripped (Windows-illegal characters).
- Notable handlers beyond straightforward service delegation:
  - `dialog:pickDirectory` — native Electron directory picker, targeting the focused or first window.
  - `clipboard:writeText` — uses Electron's `clipboard` rather than `navigator.clipboard`, because a packaged renderer loads from `file://` (not a secure context) — referenced as issue #104.
  - `workflow:saveReport` — opens a native save dialog and writes the report Markdown via `writeFile`.
  - `account:beginEnrollment` — calls `enrollment.prepare(...)` then `openTerminal(enrollment.enrollmentCommand(...))`, returning the resolved home path; throws if the runtime cannot isolate accounts.
  - `provider:scanModels` / `provider:chat` — **generic external LLM provider integration** (Ollama, OpenAI, DeepSeek, OpenRouter, Mistral, LM Studio, or custom endpoint). These make direct `fetch` calls out to `endpointUrl` (or hardcoded default endpoints per `providerId`), optionally with a bearer `apiKey`. This is the one place in `main` that talks to arbitrary external HTTP endpoints outside the agent-runtime abstraction — worth flagging for review since it bypasses the runtime/registry/binding model entirely and sends `apiKey` in a header built from renderer-supplied IPC input.
  - `template:list` / `template:get` — reads from the static `TEMPLATES` domain constant.

**Calls / depends on:** `node:fs/promises` (`writeFile`), `electron` (`app`, `clipboard`, `dialog`, `BrowserWindow`), `@shared/app` (`APP_NAME`), `@shared/domain` (`TEMPLATES`), `../audit/workflowReportGenerator`, `../projects/projectService` (type), `../projects/validateRepository`, `./router` (`IpcHandlerMap` type), `../workflows/workflowService`, `../questions/questionService`, `../decisions/decisionService`, `../changesets/changeSetService`, `../accounts/accountService`, `../runtimes/registry`, `../bindings/bindingService`, `../accounts/enrollmentService`, `../accounts/terminalLauncher` (`openTerminal`), `../terminal/terminalService`.

**Called from / used by:** `src/main/index.ts` (`createIpcHandlers(...)` result passed to `registerIpcHandlers`).

---

### `src/main/ipc/register.ts`

**Purpose:** Binds the handler map produced by `createIpcHandlers` to Electron's real `ipcMain`.

**What it does:** `registerIpcHandlers(handlers)` iterates the shared `IPC_CHANNELS` constant and calls `ipcMain.handle(channel, (_event, rawRequest) => invokeChannel(handlers, channel, rawRequest))` for each — so only contract-declared channels get a live listener; anything else is rejected by Electron itself before `invokeChannel`'s own `UNKNOWN_CHANNEL` check would even run (defence in depth, per comment).

**Calls / depends on:** `electron` (`ipcMain`), `@shared/ipc` (`IPC_CHANNELS`), `./router` (`invokeChannel`, `IpcHandlerMap`).

**Called from / used by:** `src/main/index.ts`.

---

### `src/main/ipc/router.ts`

**Purpose:** The pure routing/validation core for IPC — deliberately free of any `electron` import so it is unit-testable in plain Node.

**What it does:**
- Re-exports `IPC_CHANNELS` from `@shared/ipc` (used so a "smoke check" can compare it against the live preload bridge without restating the list).
- `IpcHandler<C>` / `IpcHandlerMap` types — one handler function per channel, receiving an already-validated request and returning `IpcResponse<C>` (sync or async).
- `invokeChannel(handlers, channel, rawRequest): Promise<IpcResult<unknown>>` — the core contract:
  1. Rejects any `channel` not recognized by `isIpcChannel` with `UNKNOWN_CHANNEL`.
  2. Parses `rawRequest ?? {}` against `IPC_CONTRACT[channel].request` (zod `safeParse`); failure → `INVALID_REQUEST` with a `z.prettifyError` message.
  3. Invokes the handler (cast through `unknown` — the code comment explains the intersection-type problem that makes indexing a mapped type over a union otherwise fail to typecheck even though it's correct at runtime); a thrown error becomes `HANDLER_FAILED`.
  4. Parses the handler's return value against `IPC_CONTRACT[channel].response`; a mismatch → `INVALID_RESPONSE` (this guards against a handler that returns the wrong shape corrupting the renderer).
  5. Success returns `{ ok: true, value: parsedResponse.data }`.
- `failure(code, message)` and `describe(error)` are small private helpers.

**Calls / depends on:** `zod`, `@shared/ipc` (`IPC_CONTRACT`, `isIpcChannel`, and several types).

**Called from / used by:** `src/main/ipc/register.ts` (`invokeChannel`), `src/main/ipc/handlers.ts` (only the `IpcHandlerMap` type), and `src/main/ipc/router.test.ts`.

---

## Accounts

### `src/main/accounts/accountAuth.ts`

**Purpose:** Probes a provider CLI's auth state for one isolated account home, and builds the environment needed to make a child process act as that account.

**What it does:**
- `accountEnv(home): Record<string,string>` — returns `{ HOME: home, USERPROFILE: home }`. Both are set because Windows resolves home via `USERPROFILE` while the CLI logic reads `HOME`; setting only one would leave a child silently authenticating as the real machine user (referenced as the bug class issue #111 exists to prevent).
- `probeAccountAuth(executable, home): Promise<AccountAuthState>` — runs `<executable> auth status` with `env: buildChildEnv(process.env, accountEnv(home))` and a 30s timeout via `execFile` (promisified). A logged-out account exits 1 but still prints valid JSON on stdout, so the function deliberately reads `error.stdout` on rejection (`readStdout`) rather than trusting the exit code.
- `parseAuthStatus(stdout): AccountAuthState` — JSON-parses stdout; any parse failure or non-object result defaults to `{ loggedIn: false, authMethod: 'none', email: null }` (fail-safe/least-trust default).
- `windowsBatchSafe(executable): [string, readonly string[]]` — Windows `.cmd`/`.bat` shims (e.g. `claude.cmd`) cannot be `execFile`'d directly (`EINVAL`) without `shell: true`, which would reopen an injection surface; instead this routes through `cmd.exe /c <script>` with the script as a discrete argument.

**Calls / depends on:** `node:child_process` (`execFile`), `node:util` (`promisify`), `../process/redact` (`buildChildEnv`).

**Called from / used by:** `src/main/runtimes/claudeCliRuntime.ts` (imports `accountEnv`); `enrollmentService.ts` imports `accountEnv` and `probeAccountAuth` too.

---

### `src/main/accounts/accountHomes.ts`

**Purpose:** Manages isolated per-account home directories so provider CLIs can write their own credentials without Forge ever handling a secret directly.

**What it does:**
- `AccountHomes` class, constructed with a `root` directory.
- `pathFor(accountId)` — `join(root, accountId, 'home')`, pure path computation, no I/O.
- `ensure(accountId)` — `mkdir(..., { recursive: true })`, idempotent; returns the home path.
- `exists(accountId)` — async `stat` check.
- `resolveExisting(accountId)` — **synchronous** (`statSync`) because it backs a runtime's `homeForAccount`, which runs inside a non-async `send` path; returns `null` (not an unchecked path) when the account was never enrolled, so a runtime fails loudly rather than silently using the machine's default identity.
- `remove(accountId)` — `rm(..., { recursive: true, force: true })`; this is the entirety of "revocation" since Forge never held the credential itself.

**Calls / depends on:** `node:fs` (`statSync`), `node:fs/promises` (`mkdir`, `rm`, `stat`), `node:path` (`join`). No other internal module dependencies.

**Called from / used by:** `src/main/index.ts` (constructs `new AccountHomes(...)`, passes `resolveExisting` into `ClaudeCliRuntime`'s `homeForAccount`), `src/main/accounts/enrollmentService.ts` (constructor-injected as `homes`).

---

### `src/main/accounts/accountService.ts`

**Purpose:** Application-layer service for Forge's own generic account records (label/provider/status), independent of the account-isolation/enrollment machinery.

**What it does:**
- `AccountService` class wrapping an injected `AccountStore`.
- `list(provider?)` — maps stored `Account`s to `AccountView`.
- `register({ provider, label })` — generates a new UUID via `accountIdSchema.parse(randomUUID())`, creates an `Account` with `status: 'connected'`, `lastUsedAt: null`, and calls `store.register(account, 'user', now)`.
- `updateStatus({ accountId, status })` — validates both via `accountIdSchema`/`accountStatusSchema`, delegates to `store.updateStatus`.
- `remove(accountId)` — delegates to `store.remove`.
- `toView(account)` — private mapper to the IPC `AccountView` shape.

**Calls / depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (`accountIdSchema`, `accountStatusSchema`, types), `@shared/ipc` (`AccountView` type), `../db/accountStore` (`AccountStore`, injected).

**Called from / used by:** `src/main/index.ts` (constructs it), `src/main/ipc/handlers.ts` (type-only import, used for `account:list`/`register`/`updateStatus`/`remove` channels).

---

### `src/main/accounts/enrollmentService.ts`

**Purpose:** Coordinates enrolling a provider account without Forge ever performing or observing the login itself.

**What it does:**
- `AccountEnrollmentView` / `EnrollmentCommand` interfaces.
- `EnrollmentService` class, constructed with `homes: AccountHomes`, `registry: RuntimeRegistry`, and `executableFor: (runtimeId) => string` (injected so tests can point at a fake CLI).
- `enrollmentCommand(runtimeId, home): EnrollmentCommand` — returns `{ command: executableFor(runtimeId), args: ['auth', 'login'], env: accountEnv(home) }`. Returned rather than executed, because login opens a browser and needs a terminal the user can see — Forge must never be positioned to intercept what's typed.
- `prepare(runtimeId, accountId): Promise<string>` — throws if the runtime `!isolatable`; otherwise calls `homes.ensure(accountId)`.
- `status(runtimeId, accountId): Promise<AccountEnrollmentView>` — computes `isolatable`, checks `homes.exists`, and if enrolled, calls `probeAccountAuth` fresh every time (deliberately not cached/remembered — a credential can expire and a stored "connected" flag would keep asserting a stale truth).
- `revoke(accountId)` — calls `homes.remove(accountId)`; this is "the whole of revocation."
- `isolatable(runtimeId)` (private) — `registry.has(runtimeId) ? registry.resolve(runtimeId).supportsAccountIsolation : false`.

**Calls / depends on:** `./accountHomes` (type), `./accountAuth` (`accountEnv`, `probeAccountAuth`, type `AccountAuthState`), `../runtimes/registry` (type `RuntimeRegistry`).

**Called from / used by:** `src/main/index.ts` (constructs it, passing `accountHomes`, `registry`, `runtimeExecutable`), `src/main/ipc/handlers.ts` (type-only import; backs `account:enrollmentStatus`, `account:beginEnrollment`, `account:revokeEnrollment`).

---

### `src/main/accounts/terminalLauncher.ts`

**Purpose:** Opens a real OS terminal window running one command with a given environment — used exclusively for interactive provider sign-in.

**What it does:**
- `openTerminal(request: { command, args, env, cwd? }): void`.
- On Windows: spawns `cmd.exe /c start "" cmd.exe /k <command> <args...>` — note the empty-string window-title argument to `start`, called out as necessary because omitting it makes `start` treat a quoted command as the title and silently open an empty shell instead.
- On other platforms: spawns the command directly.
- Both branches spawn `detached: true`, `stdio: 'ignore'`, then call `child.unref()` — nothing awaits the process; Forge learns the outcome later by probing `auth status`, not by watching this process's exit.

**Calls / depends on:** `node:child_process` (`spawn`) only.

**Called from / used by:** `src/main/ipc/handlers.ts` (`account:beginEnrollment` handler).

---

## Audit

### `src/main/audit/workflowReportGenerator.ts`

**Purpose:** Renders a self-contained, human-readable Markdown audit report for a workflow.

**What it does:**
- `WorkflowReportData` interface: `{ workflow: WorkflowDetailView, projectName: string, decisions?, questions? }`.
- `generateWorkflowReportMarkdown(data): string` — builds an array of Markdown lines and joins them:
  1. Header block: project name, workflow/task/template ids, final state, iteration count vs. max, started/finished timestamps, optional halt reason.
  2. Section 1 "Architectural Decisions" — one bullet per decision with status (upper-cased), statement, rationale, and locked timestamp if present; "no decisions" placeholder otherwise.
  3. Section 2 "Clarifications & Questions" — one bullet per question with its answer or "*Pending answer*".
  4. Section 3 "Step Execution Timeline" — Markdown table of every step (index, id, role, state, verdict, started, finished).
  5. Footer with a generation timestamp.

**Calls / depends on:** `@shared/ipc` types only (`WorkflowDetailView`, `DecisionView`, `OpenQuestionView`). No other internal module dependencies — pure formatting function.

**Called from / used by:** `src/main/ipc/handlers.ts` (`buildReport` helper, backing `workflow:exportReport` and `workflow:saveReport`).

---

## Bindings

### `src/main/bindings/bindingService.ts`

**Purpose:** Application-layer service for assigning agent runtimes to workflow roles (planner/implementer/reviewer) per project.

**What it does:**
- `ASSIGNABLE_ROLES: readonly Role[] = ['planner', 'implementer', 'reviewer']` — deliberately excludes `system` and `user`, which Forge performs itself.
- `BindingService` class, constructed with `bindings: BindingStore` and `registry: RuntimeRegistry`.
- `list(projectId): RoleBindingsView` — for every assignable role, returns its current stored binding (or `null`) plus `eligibleRuntimes` computed from `registry.candidatesForRole(role)` — so the UI can never present a choice that `bindRole` would later reject.
- `set({ projectId, role, runtimeId }): AgentBindingView` — validates ids/role via zod schemas, calls the shared `bindRole(registry, { role, runtimeId })` helper (capability check happens here, at bind time, not when a step runs — so a read-only runtime bound as implementer can't fail mid-workflow), persists via `bindings.set(...)`.
- `toView(runtimeId, binding)` (private) — looks up `simulated` from the registry live (not stored on the binding), because whether a runtime is simulated is a property of the runtime *now*, not of when the binding was made (issue #101).

**Calls / depends on:** `@shared/domain` (`projectIdSchema`, `roleSchema`, `Role` type), `@shared/ipc` (view types), `../db/bindingStore` (`BindingStore`), `../runtimes/bindings` (`bindRole`), `../runtimes/registry` (`RuntimeRegistry`).

**Called from / used by:** `src/main/index.ts` (constructs it, passing `new BindingStore(db, eventStore)` and `registry`), `src/main/ipc/handlers.ts` (type-only import; backs `binding:list`/`binding:set`).

---

## Changesets

### `src/main/changesets/changeSetService.ts`

**Purpose:** Application-layer service for change sets (recorded diffs) and for ad-hoc git access needed by the Explorer/diff UI.

**What it does:**
- `ChangeSetServiceOptions { changeSets: ChangeSetStore, projects: ProjectService }`.
- `list(projectId)` / `get(changeSetId)` — read and map to `ChangeSetView` via `toChangeSetView`.
- `getWorkingDiff(projectId)` — resolves a `GitService` for the project, gets `headSha() ?? 'HEAD'`, diffs the worktree against it, returns `{ files, patch }`.
- `listFiles(projectId)` — returns every file git tracks or would track (referenced as issue #107, for the file browser).
- `readFile(projectId, relativePath)` / `writeFile(projectId, relativePath, content)` — read/write a file inside the project's worktree via `GitService`.
- `getGitService(projectId)` (private) — parses the project id, loads project detail via `ProjectService.get`, throws if not found, and constructs a **new** `GitService({ repositoryPath: ... })` per call (not cached).
- `toChangeSetView(cs)` (module-level function) — maps the full `ChangeSet` domain object to `ChangeSetView`, including `discrepancies`, `reviewVerdict`, `correctsChangeSetId`, etc.

**Calls / depends on:** `@shared/domain` (`changeSetIdSchema`, `projectIdSchema`, `ChangeSet` type), `@shared/ipc` (view types), `../db/changeSetStore` (`ChangeSetStore`), `../git` (`GitService`), `../projects/projectService` (type).

**Called from / used by:** `src/main/index.ts` (constructs it with `workflows.getChangeSetStore()` and `projectService`), `src/main/ipc/handlers.ts` (type-only import; backs `changeset:list`/`get`, `git:getWorkingDiff`/`listFiles`/`readFile`/`writeFile`).

---

## Context

### `src/main/context/index.ts`

**Purpose:** Barrel re-export module for the context package.

**What it does:** Single line: `export { PacketStore, type PacketStoreOptions } from './packetStore'`. Note: `repositoryInstructions.ts` is **not** re-exported here — consumers (`workflowService.ts`) import it directly from `../context/repositoryInstructions` rather than through this barrel.

**Calls / depends on:** `./packetStore`.

**Called from / used by:** No direct importer found in a repo-wide grep for `context/index` or a bare `@main/context` import; `PacketStore` itself is imported directly from `../context/packetStore` everywhere it's used (`workflowService.ts`, `orchestrator.ts`, and two test files) rather than through this barrel — this file may be effectively dead/unused in the current wiring, worth confirming during refactor.

---

### `src/main/context/packetStore.ts`

**Purpose:** Content-addressed snapshot store for prompt packets on disk, so a resumed step replays the exact context it originally sent and audit trails remain byte-for-byte reconstructable.

**What it does:**
- `PacketStoreOptions { directory: string }`.
- `PacketStore` class.
- `save(packet: PromptPacket): Promise<string>` — serializes deterministically (`serialise`), hashes it (`hashOf`) to produce the reference, `mkdir`s the directory, writes `<reference>.json`. Idempotent: identical packets produce identical bytes/reference, so a redone step after a crash yields the same `contextRef`.
- `load(reference): Promise<PromptPacket | null>` — reads the file, and **re-hashes the content and compares it to the requested reference**; a mismatch (e.g., hand-edited file) returns `null` rather than the packet, treating "not what it claims to be" as worse than absent. Validates via `promptPacketSchema.parse`.
- `pathFor(reference)` (private) — `join(directory, \`${reference}.json\`)`.
- `serialise(packet)` (module-level) — `JSON.stringify(sortKeys(packet), null, 2)`.
- `sortKeys(value)` (module-level) — recursively rebuilds objects with keys sorted at every depth (deliberately *not* using `JSON.stringify`'s replacer-array form, which the comment states was measured to apply the key list at every depth and silently collapse nested objects like `previousAttempt`/`answeredQuestions` to `{}`).
- `hashOf(serialised)` — SHA-256, truncated to 32 hex chars (16 bytes); explicitly stated as not a security boundary, just a content identifier.

**Calls / depends on:** `node:crypto` (`createHash`), `node:fs/promises` (`mkdir`, `readFile`, `writeFile`), `node:path` (`join`), `@shared/domain` (`promptPacketSchema`, `PromptPacket` type).

**Called from / used by:** `src/main/workflows/workflowService.ts` (constructs `this.packets = new PacketStore({ directory: options.packetDir })`, uses `.load()` in `getPacket`), `src/main/runtimes/orchestrator.ts` (type-only), plus two test files.

---

### `src/main/context/repositoryInstructions.ts`

**Purpose:** Reads a repository's own agent-instructions file (e.g. `CLAUDE.md`-equivalent), if present, so it can be folded into the prompt packet Forge controls.

**What it does:**
- `readRepositoryInstructions(repositoryPath, filenames): Promise<string | null>` — tries each candidate filename in order (first existing non-blank file wins), reading via `readFile(join(repositoryPath, filename), 'utf8')`. Any error (ENOENT, permission error, directory-in-place, decode failure) is caught and treated identically as "try the next candidate" — deliberately broad and non-fatal, since a repo instructions file missing or unreadable must never fail an otherwise-runnable workflow.
- Returns `null` if none of the candidates yield usable content.
- Filenames are **not** hardcoded here — they're passed in by the caller, sourced from the runtime bound to the role, since which file a provider's CLI reads is provider-specific and core (this file) must not name a specific vendor's convention (referenced as axiom A6).

**Calls / depends on:** `node:fs/promises` (`readFile`), `node:path` (`join`). No internal module dependencies.

**Called from / used by:** `src/main/workflows/workflowService.ts` (`compilePacket` closure, called once per step with `instructionFilenames` resolved from `registry.resolve(boundRuntimeId).instructionFilenames`).

---

## Decisions

### `src/main/decisions/decisionService.ts`

**Purpose:** Application-layer service for architectural decisions (propose/approve/lock/supersede workflow).

**What it does:**
- `DecisionServiceOptions { decisions: DecisionStore, onDecisionChanged?: (decision) => void }`.
- `list(projectId, status?)` / `get(decisionId)` — read, validated via zod schemas, mapped via `toView`.
- `propose({ projectId, statement, rationale })` — creates a new `Decision` with `status: 'proposed'`, `proposedBy: 'user'`, `lockedAt/lockedBy: null`, `supersededBy: null`, `originQuestionId: null`; persists via `store.propose`, fires `onDecisionChanged`.
- `approve(decisionId)` / `lock(decisionId)` — thin wrappers around `store.approve`/`store.lock`, each firing `onDecisionChanged`.
- `supersede({ decisionId, replacementStatement, replacementRationale })` — builds a brand-new `Decision` (status `'locked'` immediately, `lockedAt`/`lockedBy` set to now/'user'), calls `store.supersede(dId, replacement, ...)` which atomically marks the old one superseded and creates the new one; fires `onDecisionChanged` **twice** (once for the superseded decision, once for the replacement); returns both views.
- `toView(d)` (module-level) — maps `Decision` → `DecisionView`.

**Calls / depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (schemas/types), `@shared/ipc` (`DecisionView`), `../db/decisionStore` (`DecisionStore`).

**Called from / used by:** `src/main/index.ts` (constructs it with `workflows.getDecisionStore()`), `src/main/ipc/handlers.ts` (type-only import; backs `decision:list/get/propose/approve/lock/supersede`). Note: `workflowService.ts` reads decisions through its own `DecisionStore` instance directly (`this.decisions`), not through this service — the service and the workflow engine each hold their own store reference onto the same underlying table.

---

## Evidence

### `src/main/evidence/changeSetBuilder.ts`

**Purpose:** Builds a `ChangeSet` domain object from what the repository actually shows (git diff) reconciled against what an agent *claimed* it did.

**What it does:**
- `BuildChangeSetInput` — `baseSha`, `report: AgentReport`, `scope: ScopePolicy`, `authorActor`, `stepId`, `taskId`, optional `correctsChangeSetId`, `capturedAt`.
- `BuiltChangeSet { changeSet, reconciliation }`.
- `buildChangeSet(git, input): Promise<BuiltChangeSet>` — diffs the **worktree** (not a commit range — an agent's work is normally uncommitted, referenced as issue #17), calls the shared `reconcile({ claimed, actual, scope })` to compute discrepancies, then constructs and zod-validates a `ChangeSet` via `changeSetSchema.parse`. `headSha` is always `null` at this point (work is uncommitted; final commit is the user's call). `reviewVerdict` is always `null` here too — set later by the review step (issue #36), not by this builder. Strips the `binary` field off each diffed file before storing.
- `diffStatOf(changeSet): string` — one-line summary ("N file(s), +X -Y") used in a correction packet's `previousAttempt`, explicitly Forge's own measurement rather than the agent's self-report.

**Calls / depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (`reconcile`, schemas, many types), `../git` (`GitService` type).

**Called from / used by:** `src/main/workflows/workflowService.ts` (`reconcileStep` closure inside `executeWorkflow`).

---

### `src/main/evidence/commandRunner.ts`

**Purpose:** The one place Forge runs a project's own configured build/test shell commands and captures the result as an `EvidenceArtifact`.

**What it does:**
- Deliberately uses a **real shell** (`execFile` via `cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere) — unlike `GitService`/`ProcessManager`, which both refuse a shell to avoid injection from attacker-influenced values. Here the whole command string *is* the trusted, user-configured input (`repository.buildCommand`/`testCommand`).
- `RunCommandInput` — `command`, `cwd`, `kind` (`'build'|'tests'`), `workflowId`, `stepId`, optional `timeoutMs`, `maxOutputBytes`, `env`, `now`, `signal`.
- `runCommand(input): Promise<EvidenceArtifact>` — **never throws**; a failed command is a normal, recorded result. Key behaviors:
  - Owns its own timer for the timeout (`DEFAULT_TIMEOUT_MS = 15min`) rather than passing `timeout`/`signal` to `execFile` directly — documented as necessary because `execFile`'s built-in timeout kills only the immediate shell child, and by the time the completion callback runs to attempt a tree-kill, the shell parent is already gone (`taskkill /T` then finds nothing to walk). Owning the timer kills the tree while the shell is still alive.
  - `killTree(pid)` — Windows: synchronous `execFileSync('taskkill', ['/PID', pid, '/T', '/F'])`. POSIX: `process.kill(-pid, 'SIGKILL')` (process group) falling back to `process.kill(pid, 'SIGKILL')` if that throws ESRCH (measured on Linux CI to be necessary even with `detached: true`).
  - Handles four abnormal outcome shapes distinctly, documented from measurement against Node 22/win32: normal exit (`code` is a number), timeout (`code === null`, `killed === true`), maxBuffer overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, child killed, exit code lost — reported as `'spawn-failed'` with `truncated: true`), and spawn failure (`ENOENT`-style, string `code`, shell never ran).
  - Also settles from the child's `exit` event (not just `close`) when this runner has imposed an ending (`ending !== null`) — because on Linux, a SIGKILLed shell fires `exit` while `close` never arrives if a grandchild still holds an inherited stdout pipe open; Windows doesn't need this path since `taskkill /T` makes both events land together.
  - Redacts stdout/stderr via `redactSecrets` before storing, and parses test counts via `parseTestCounts` (only when `kind === 'tests'`), from the **redacted** copies (redaction only rewrites values, not the count fields the parser reads).
- `shellInvocation(command)` (private) — picks `cmd.exe /d /s /c` (Windows) or `/bin/sh -c` (POSIX).
- `buildEnv(extra)` (private) — starts from `process.env` filtered through a **local** `isSecretName` pattern list (deliberately narrower/separate from `process/redact.ts`'s, since that one's broad `auth` match would strip variables a build legitimately needs), then forces `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`, `GIT_TERMINAL_PROMPT=0`.

**Calls / depends on:** `node:child_process` (`execFile`, `execFileSync`), `node:crypto` (`randomUUID`), `@shared/domain` (schemas, `redactSecrets`, types), `./testParsers` (`parseTestCounts`).

**Called from / used by:** `src/main/evidence/verifier.ts` (default `run` implementation, injectable). **Not called anywhere else in production code** — `verifyStep` is the only production caller; everything else referencing `runCommand` is a `.test.ts` file. Worth confirming this is intentional (it is the verifier's engine, so this is expected, not dead code).

---

### `src/main/evidence/index.ts`

**Purpose:** Barrel re-export for the evidence package.

**What it does:** Re-exports `buildChangeSet`/`diffStatOf` (from `changeSetBuilder`), `runCommand` (from `commandRunner`), `parseTestCounts` (from `testParsers`), `verifyStep` (from `verifier`), plus their associated types.

**Calls / depends on:** `./changeSetBuilder`, `./commandRunner`, `./testParsers`, `./verifier`.

**Called from / used by:** No direct importer found via grep of the barrel path itself — all real consumers (`workflowService.ts`) import `buildChangeSet`/`verifyStep` directly from their concrete files (`../evidence/changeSetBuilder`, `../evidence/verifier`) rather than through this index. Likely only used for local test convenience or as a public package surface not yet wired up.

---

### `src/main/evidence/verifier.ts`

**Purpose:** Implements the `system`-role verification step: runs the project's configured build/test commands and computes a three-way pass/fail/unknown verdict, replacing what used to be an injected boolean stub.

**What it does:**
- `VerifyInput` — `repository`, `workflowId`, `stepId`, optional `report` (agent's claim, used only to detect contradicted claims — never to decide the verdict), optional `task` (whose completion criteria decide the verdict per issue #35 — without one, verdict is `unknown` at best), optional `reconciliation`, `reviewVerdict`, `existingPaths`, `timeoutMs`, `now`, `signal`, and an injectable `run` function (defaults to `runCommand`).
- `VerifyResult` — `passed` (`true` **only** for verdict `'pass'` — deliberately not `verdict !== 'fail'`, so `'unknown'` never silently advances a workflow), `verdict: Verdict`, `criteria: readonly CriterionResult[]`, `detail`, `artifacts`, `findings`, `falseClaims`.
- `verifyStep(input): Promise<VerifyResult>` — runs build first, and **skips tests entirely if the build failed** (a test run against a non-compiling tree produces noise labelled `'tests'`). Aggregates findings via `evidenceFindings`. Calls `assessCompletion({ task, evidence, reconciliation, report, reviewVerdict, existingPaths })` when a `task` was supplied — that assessment's verdict wins; otherwise verdict is `'unknown'` if no artifacts ran, `'pass'` if all passed, `'fail'` otherwise.
- `detectFalseClaims(report, repository, artifacts)` — the "liar" scenario the comment references: catches an agent report claiming `testsRun: true` when either (a) no test command is configured at all, or (b) tests were configured, ran, and did not pass. This complements (but is distinct from) `reconcile`'s file-diff-based discrepancy detection, since no diff can see a false `testsRun` claim.
- `detailFor(artifacts, falseClaims)` — one-line summary leading with the worst outcome, via `summariseEvidence`.

**Calls / depends on:** `@shared/domain` (`assessCompletion`, `evidenceFindings`, `evidencePassed`, `summariseEvidence`, many types), `./commandRunner` (`runCommand`, `RunCommandInput` type).

**Called from / used by:** `src/main/workflows/workflowService.ts` (`verify` callback passed into `Orchestrator.run`).

---

## Health

### `src/main/health/healthCheck.ts`

**Purpose:** First-run/startup diagnostics: verifies Node version, Git availability, and storage-directory writability.

**What it does:**
- `CheckItem { ok, detail }`, `HealthCheckReport { healthy, timestamp, checks: { node, git, storage } }`.
- `checkNodeVersion(versionString = process.versions.node)` — parses the major version, requires `>= 22`.
- `checkGitAvailable(runner = execSync wrapper)` — runs `git --version` and checks the output contains "git version"; injectable runner for testing.
- `checkStorageWritable(targetDir)` — `mkdirSync` if absent, writes then removes a `.healthcheck-<timestamp>.tmp` probe file.
- `runHealthChecks(dataDir): HealthCheckReport` — runs all three and combines them into `healthy = node.ok && git.ok && storage.ok`.

**Calls / depends on:** `node:child_process` (`execSync`), `node:fs` (`existsSync`, `mkdirSync`, `rmSync`, `writeFileSync`), `node:path` (`join`). No internal module dependencies.

**Called from / used by:** **No production caller found** — only referenced from its own `.test.ts` file. This module appears to be dead code / not wired into `index.ts`'s startup sequence at all. Worth flagging explicitly for the refactor: either it should be called during `app.whenReady()` (e.g., before `startDatabase()`) or removed.

---

## Logging

### `src/main/logging/appLogger.ts`

**Purpose:** A simple rotating file logger for app-level diagnostics, independent of the per-process logs `ProcessManager` writes.

**What it does:**
- `AppLoggerOptions { logDir, maxFileSizeMb? }`.
- `AppLogger` class — ensures `logDir` exists in the constructor; `logPath = join(logDir, 'forge-app.log')`; `maxBytes = (maxFileSizeMb ?? 10) * 1024 * 1024`.
- `log(level, tag, message, data?)` — rotates if needed, redacts `tag`/`message`/`JSON.stringify(data)` via `redactSecrets`, appends a line `[timestamp] [LEVEL] [tag] message | data`. Wrapped in try/catch that silently swallows all errors ("disk logging should never crash the caller").
- `info`/`warn`/`error` convenience wrappers.
- `rotateIfNeeded()` (private) — if the log file exceeds `maxBytes`, deletes it outright (not a rename/rotate-to-`.1` scheme — the whole file is dropped). Also wrapped in a swallowing try/catch.

**Calls / depends on:** `node:fs` (`appendFileSync`, `existsSync`, `mkdirSync`, `statSync`, `unlinkSync`), `node:path` (`join`), `@shared/domain` (`redactSecrets`).

**Called from / used by:** **No importer found anywhere else in `src`** — this class is defined but never constructed/used outside its own file. Dead code as it stands; flag for the refactor (either wire it into `index.ts`'s startup, e.g. for the console.warn calls currently only going to stdout, or remove it).

---

## Process

### `src/main/process/index.ts`

**Purpose:** Barrel re-export for the process package.

**What it does:** Re-exports `ProcessManager` and its types from `./processManager`; `isAlive`, `OrphanTracker`, and types from `./orphans`; `buildChildEnv`, `isSecretEnvName`, `REDACTION`, `redactOutput`, `stripAnsi`, `withheldEnvNames` from `./redact`.

**Calls / depends on:** `./processManager`, `./orphans`, `./redact`.

**Called from / used by:** `src/main/index.ts` (`import { OrphanTracker, ProcessManager } from './process'`) — the only barrel among the context/process/evidence trio that is actually consumed as a barrel in production code.

---

### `src/main/process/orphans.ts`

**Purpose:** Tracks spawned child process ids across app restarts to a JSON file, so a hard crash (no shutdown hook ran) doesn't leave agent CLIs running unsupervised against the user's repository.

**What it does:**
- Zod schemas: `trackedProcessSchema` (`pid`, `command`, `startedAt`), `trackedFileSchema` (`ownerPid`, `processes[]`). `ownerPid` is compared on startup so an instance never treats its *own* children as orphans, and — more importantly — so a second concurrently-running Forge instance isn't mistaken for a crashed one (which would wrongly kill its live agents).
- `isAlive(pid)` — `process.kill(pid, 0)` (signal 0 = existence probe only); treats `EPERM` (process exists, owned by someone else) as **alive**, since a false "dead" answer would be the dangerous direction (real orphan left running).
- `OrphanTracker` class, constructed with `file` path and `ownerPid` (defaults to `process.pid`).
  - `record(entry)` / `forget(pid)` — mutate the in-memory `tracked` array and `flush()` to disk on every change (kept small deliberately — "what's running now", not a history).
  - `reap(): Promise<OrphanReport>` — called once at startup, before any workflow resumes. Reads the previous file; if `previous.ownerPid !== this.ownerPid && isAlive(previous.ownerPid)`, treats all entries as `foreign` (another live Forge owns them, hands-off). Otherwise, for each entry: if not alive, `stale`; if alive, `process.kill(entry.pid)` directly (no pty to route through — the previous run's pty handle died with the crash, so this is the one place a raw pid kill is correct) and records it as `killed`. Clears the tracked file after reaping.
  - `read()` (private) — tolerant of a corrupt/missing file (returns `null`, discarding rather than failing startup).
  - `flush()` (private) — deletes the file entirely when `tracked` is empty, otherwise overwrites it with `{ ownerPid, processes }`.

**Calls / depends on:** `node:fs/promises` (`readFile`, `unlink`, `writeFile`), `zod`.

**Called from / used by:** `src/main/index.ts` (constructs `new OrphanTracker(...)`, calls `.reap()`), `src/main/process/processManager.ts` (constructor-injected `orphans` option; calls `.record()` on spawn and `.forget()` on settle), `src/main/runtimes/pipeProcessRunner.ts` (type-only import).

---

### `src/main/process/processManager.ts`

**Purpose:** Owns every pty-backed child process Forge starts — spawn, streaming, idle/hard timeouts, escalating cancellation, concurrency-capped queueing, and app-quit teardown.

**What it does:**
- Uses `node-pty` (not a plain pipe) because the CLIs Forge drives are interactive programs that change behavior — or refuse to run — when stdout isn't a TTY. Extensive comment on `node-pty@1.1.0`'s platform-dependent prebuilds (`darwin-arm64/x64`, `win32-arm64/x64`; **not** `linux-x64`, must be compiled there).
- `ProcessManagerOptions` — `maxConcurrent` (default 2, "max 2 concurrent agents"), `logDirectory`, `maxLogBytes` (default 2MB), `now` (injectable clock), `orphans` (optional `OrphanTracker`).
- `SpawnRequest` — `command`, `args`, `cwd`, `env?`, `idleTimeoutMs?`, `hardTimeoutMs?`, `cols?`, `rows?`.
- `ProcessOutcomeReason` — `'exited' | 'cancelled' | 'idle-timeout' | 'hard-timeout' | 'spawn-failed'`.
- `ProcessHandle` — `runId`, `onData`/`onRawData` (raw is unredacted/unstripped, for a terminal view that must reproduce the actual screen; comment stresses this is a deliberate second channel, not a relaxation of the redacted one), `completed: Promise<ProcessOutcome>` (never rejects), `write`, `resize?`, `cancel(reason?)`.
- `resolveCommand(command, env)` (exported) — resolves a bare command name against `PATH`/`PATHEXT` manually, because `node-pty` on Windows passes the command straight to `CreateProcess`, which does **not** search PATH (`spawn('git', ...)` throws `File not found:`). Resolving here rather than via a shell avoids reopening the injection surface `execFile` was chosen to close elsewhere. Falls back to returning the original name unresolved if nothing matches (surfaces as a normal `spawn-failed`).
- `ProcessManager` class:
  - `spawn(request): Promise<ProcessHandle>` — queues if `running.size >= maxConcurrent`; builds a sanitized child env via `buildChildEnv`; resolves the command; special-cases `.cmd`/`.bat` shims on Windows by routing through `cmd.exe /d /c <resolved> <args>`; spawns via `node-pty`; on spawn failure, settles immediately as `'spawn-failed'`; on success, records the pid with `orphans?.record(...)` **immediately after spawn** (so a crash before first output still leaves a recoverable trace); wires `onData`/`onExit`; arms timers.
  - `record(run, data)` (private) — strips ANSI (`stripAnsi`) **before** redacting (`redactOutput`) — order matters because ConPTY splices an OSC title sequence *inside a word*, so redaction patterns could otherwise be defeated by an escape sequence landing mid-token. Caps stored/emitted output at `maxLogBytes` (truncates, does not rotate — "the tail of a runaway process is rarely the useful part"). Emits both a redacted `'data'` event and an unmodified `'raw'` event. Re-arms the idle timer on every chunk.
  - `armIdleTimer` / `armTimers` — idle timeout measures silence (re-armed per chunk); hard timeout is a total wall-clock ceiling, armed once.
  - `cancel(runId, reason?)` — delegates to `terminate`.
  - `terminate(run, reason, detail)` (private) — the core kill logic: **Windows has no signals at all** — `pty.kill(signal)` throws `"Signals not supported on windows."` from inside a deferred callback that a try/catch cannot catch (surfaces as an uncaught exception) — so Windows always calls the no-argument `pty.kill()`, which kills the ConPTY agent owning the console the whole child tree is attached to. POSIX escalates `SIGINT` → (2s grace) → `SIGTERM` → (4s grace) → `SIGKILL`. Resolves once the process actually exits (`run.emitter.once('settled', resolve)`), not merely once a signal was sent.
  - `settle(run, reason, exitCode?, signal?)` (private) — clears timers, builds the `ProcessOutcome`, removes from `running`, calls `orphans?.forget(pty.pid)`, resolves the completion promise, emits `'settled'`, persists the log **after** resolving (so a slow disk never delays the caller — a log-write failure must not fail the run), and pulls the next queued spawn.
  - `persist(run, outcome)` (private) — writes `<logDirectory>/<runId>.log` with a header including `withheldEnv` names (so the redaction decision itself is auditable) followed by the captured output.
  - `killAll(reason?)` — sets `disposed = true` (refuses further spawns), drains the queue (releasing anyone waiting for a slot), and awaits `terminate` on every currently running process **in parallel** (so quit doesn't take the sum of every process's individual grace period).
- `activeCount` / `queuedCount` getters.

**Calls / depends on:** `node:events` (`EventEmitter`), `node:fs` (`accessSync`, `constants`), `node:fs/promises` (`appendFile`, `mkdir`), `node:path` (`delimiter`, `isAbsolute`, `join`), `node-pty` (`spawn as spawnPty`, `IPty`), `./orphans` (type `OrphanTracker`), `./redact` (`buildChildEnv`, `redactOutput`, `stripAnsi`, `withheldEnvNames`).

**Called from / used by:** `src/main/index.ts` (constructs the single `ProcessManager` instance, passed to `HostedClaudeRuntime` and `TerminalService`), `src/main/terminal/terminalService.ts` (type-only, holds handles), `src/main/runtimes/ptyProcessRunner.ts`, `src/main/runtimes/pipeProcessRunner.ts` (imports `resolveCommand`), `src/main/runtimes/hostedClaudeRuntime.ts`, plus several test files.

---

### `src/main/process/redact.ts`

**Purpose:** Secret redaction for child-process environments and output, in both directions — what Forge withholds from a child, and what it scrubs before persisting a child's output.

**What it does:**
- `SECRET_NAME_PATTERNS` — broad, shape-based (not vendor-named, per axiom A6) regex list: `token`, `secret`, `password`, `passwd`, `pwd`, `api[-_]?key`, `access[-_]?key`, `private[-_]?key`, `credential`, `session[-_]?id`, `auth`, `^npm_config__auth`.
- `ALLOWED_NAMES` — explicit allowlist overriding the above: `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS` (not secrets, needed so tools know whether to prompt).
- `isSecretEnvName(name)` — allowlist wins over pattern match.
- `buildChildEnv(parentEnv, extra?)` — starts from an **explicit empty base** rather than spreading `process.env` wholesale (default is to drop; passing something through is a deliberate act), filters out secret-shaped names, then merges in `extra` unconditionally (an explicit caller-supplied value is trusted).
- `withheldEnvNames(parentEnv)` — sorted list of names that would be filtered, for audit logging.
- ANSI stripping: `OSC_PATTERN` (`ESC ] … BEL` or `ESC ] … ESC \`), `CSI_PATTERN` (cursor/color/clear sequences), `LONE_ESCAPE_PATTERN` — documented with a measured example of ConPTY splicing an OSC title sequence *mid-word* inside `git --version`'s output.
- `stripAnsi(text)` — applies all three patterns in sequence. Deliberately kept separate from redaction (a caller may want raw-but-readable text and redacted text independently — e.g., the raw terminal-view channel in `ProcessManager`).
- Re-exports `REDACTION` and `redactSecrets as redactOutput` from `@shared/domain` rather than reimplementing value-shape redaction — explicitly to avoid the two copies drifting (the one that drifts being the one that leaks).

**Calls / depends on:** `@shared/domain` (`REDACTION`, `redactSecrets`) — only for re-export.

**Called from / used by:** `src/main/process/processManager.ts` (`buildChildEnv`, `redactOutput`, `stripAnsi`, `withheldEnvNames`), `src/main/accounts/accountAuth.ts` (`buildChildEnv`), `src/main/runtimes/pipeProcessRunner.ts` (`buildChildEnv`, `redactOutput`, `stripAnsi`).

---

## Projects

### `src/main/projects/projectService.ts`

**Purpose:** Application-layer service for projects: creation (with repository binding and initial rules), rule management, effective-policy resolution, update, and deletion.

**What it does:**
- Constructed with a `ForgeDatabase` and an **injected predicate** `hasRunningWorkflow?: (projectId) => boolean` (defaults to always-false). This predicate is injected rather than resolved by depending on `WorkflowService` directly, since projects are the lower layer and workflows already depend on this service — a back-reference would make the dependency cycle real. `index.ts` wires this via a late-bound closure (`workflows !== null && workflows.getActive(projectId) !== null`).
- `create(request)` — probes the repository via `validateRepository` first; **refuses** if `!probe.isRepository` (a project bound to a non-repo path could never run a workflow). A dirty worktree is explicitly *not* a blocker here (only `GitService.snapshot()` refuses on dirty state, at the point a base SHA is actually captured). Generates ids via `randomUUID`, persists via `store.create`, and writes each non-blank initial rule as a **separate event** (`project.rule.N` positional key) so each can later be superseded/removed independently and the log shows what existed when a workflow ran.
- `setRule(projectId, scope, key, statement)` — the `(scope, key)` pair is the identity: setting an existing key **overrides** (reuses the existing rule id so the event log reads as "one rule changing" rather than "a new rule appearing at the same coordinates"); a genuinely new key creates a new rule id. Returns the full `ProjectDetail` (not just the rule) so the caller re-reads the resolved policy instead of patching its own copy.
- `removeRule(projectId, ruleId)` — delegates to `store.removeRule`, returns fresh detail.
- `resolvePolicy(projectId)` — `resolveEffectivePolicy([...FORGE_DEFAULT_RULES, ...rules.listForProject(projectId)])`; computed fresh on every read (not cached/stored), since caching would mean a rule edit that doesn't take effect until an invalidation.
- `list()` — maps all stored projects to `ProjectView`.
- `get(rawProjectId)` — re-probes the repository via `validateRepository` on **every read** (not cached at creation), since the branch/commits/folder can all change or vanish between opens. Returns `probe: null` (rather than a probe full of problems) when the path has stopped being a repository, so the UI can say "the repository is missing" instead of listing validation failures.
- `update(request)` — **cannot** change `repositoryPath` (that would invalidate every recorded path/diff-base/changeset — described as "a new project rather than an edit"). **Refused while a workflow is running** (via `hasRunningWorkflow`), because `defaultBranch` is the diff base and moving it mid-run would change what "changed" means mid-comparison. Distinguishes `undefined` ("leave unchanged") from explicit `null` ("clear the command") for `buildCommand`/`testCommand`.
- `delete(rawProjectId)` — also refused while a workflow is running (would orphan child processes and leave state undefined).
- `emptyToNull(value)` / `toProjectView(project)` / `toRuleView(rule)` — module-level mapping helpers.

**Calls / depends on:** `node:crypto` (`randomUUID`), `@shared/domain` (many schemas/types, `FORGE_DEFAULT_RULES`, `resolveEffectivePolicy`), `@shared/ipc` (view types), `../db` (`ForgeDatabase` type), `../db/projectStore` (`ProjectStore`), `../db/ruleRepository` (`RuleRepository`), `./validateRepository`.

**Called from / used by:** `src/main/index.ts` (constructs it, wires the `hasRunningWorkflow` closure), `src/main/ipc/handlers.ts` (type-only import; backs `project:*` and `rule:*` channels), `src/main/workflows/workflowService.ts` (`projects: ProjectService` option, used throughout `executeWorkflow`), `src/main/terminal/terminalService.ts` (`projects.get(...)` to resolve the terminal's cwd), `src/main/changesets/changeSetService.ts` (`projects.get(...)` to resolve the repository path).

---

### `src/main/projects/validateRepository.ts`

**Purpose:** Probes a candidate directory before a project is bound to it, producing named-reason diagnostics rather than a generic "invalid path".

**What it does:**
- `validateRepository(candidatePath): Promise<RepositoryProbe>` — sequence of checks, each returning early via the `probe({ problems })` helper on hard failure:
  1. Empty/blank path → `empty-path`.
  2. Not absolute → `not-absolute` (a relative path would resolve against Forge's own cwd, not the user's).
  3. `stat` fails → `missing`; also calls `realpath` to canonicalize (handles Windows 8.3 short names / case differences, so the stored path matches what git later reports).
  4. Not a directory → `not-a-directory`.
  5. `git.isRepo()` false → distinguishes `not-a-repository` (genuinely outside any repo) from `inside-repository` (a subdirectory of one — found via `findEnclosingRepository`, suggesting the user bind the root instead, so recorded paths match git's own output).
  6. If it is a repo: gathers `currentBranch`, `defaultBranch`, `listBranches`, `headSha`, `status`, and the enclosing repo root **in parallel** via `Promise.all`. Adds non-blocking `problems` for `no-commits` (empty repo — legitimate to bind, but no workflow can start without a base commit) and `detached-head`.
  7. Returns `dirty`/`dirtyPaths`(capped at 20)/`dirtyCount` from combining `status.entries`, `.untracked`, `.conflicted` — explicitly **not** a blocker (comment: "The one place a dirty tree becomes a hard refusal is `GitService.snapshot()`").
- `posix(value)` — converts backslashes to forward slashes; used so the stored path form is stable across the UI, git comparisons, and prompt packets.
- `probe({ problems })` — fills in the "nothing readable" shape for early-return cases.
- `findEnclosingRepository(directory)` — runs `git rev-parse --show-toplevel` directly (since `GitService` itself deliberately refuses to run from inside a subdirectory) to find/confirm the true root, including expanding 8.3 short names (which `realpath` does not, per the comment).

**Calls / depends on:** `node:fs/promises` (`realpath`, `stat`), `node:path` (`isAbsolute`), `@shared/ipc` (`RepositoryProbe`, `RepositoryProbeProblem` types), `../git` (`GitService`), `../git/exec` (`runGit`).

**Called from / used by:** `src/main/ipc/handlers.ts` (`project:probeRepository` channel), `src/main/projects/projectService.ts` (`create` and `get`).

---

## Questions

### `src/main/questions/questionService.ts`

**Purpose:** Application-layer service for open questions an agent raises when it hits genuine ambiguity.

**What it does:**
- `QuestionServiceOptions { questions: QuestionStore, onQuestionAnswered?: (question) => void }`.
- `list(projectId, unansweredOnly?)` — delegates to `store.listForProject(pId, { unansweredOnly: unansweredOnly === true })`, maps via `toView`.
- `get(questionId)` — validated lookup.
- `answer(questionId, answerText)` — delegates to `store.answer(qId, answerText, 'user', now)`, fires `onQuestionAnswered`, returns the view. Note: this is a **simpler** answer path than the one actually invoked from IPC (`workflow:answerQuestion` calls `workflows.answerQuestion` directly on `WorkflowService`, which additionally handles `promoteToDecision` and resumes any workflow blocked on the question — see `workflowService.ts`). This service's own `answer` method appears **unused by the IPC layer** — `question:answer` in `handlers.ts` routes to `workflows.answerQuestion`, not `questions.answer`. Worth flagging: `QuestionService.answer` may be effectively dead/only for direct/test use.
- `toView(q)` (module-level) — maps `OpenQuestion` → `OpenQuestionView`.

**Calls / depends on:** `@shared/domain` (`projectIdSchema`, `questionIdSchema`, `OpenQuestion` type), `@shared/ipc` (`OpenQuestionView`), `../db/questionStore` (`QuestionStore`).

**Called from / used by:** `src/main/index.ts` (constructs it with `workflows.getQuestionStore()`), `src/main/ipc/handlers.ts` (type-only import; backs `question:list`/`question:get` — but **not** `question:answer`, which goes to `workflows.answerQuestion` instead).

---

## Terminal

### `src/main/terminal/sessionRegistry.ts`

**Purpose:** A live registry mapping a running workflow step to its attachable process handle, so the workflow pane UI can attach to the *actual* agent process instead of spawning a second, unrelated session (fixes issue #154, where the workflow pane used to render an unrelated spawned session while the real agent ran unobserved).

**What it does:**
- `AttachableProcess { write?, resize? }` — deliberately narrower than `ProcessHandle`: a pane may write/resize but must not cancel the step or await its outcome (that belongs to the orchestrator, which owns the run's lifetime). Both members optional since not every transport carries them (a pipe closes stdin after the prompt and has no window size; a pty has both).
- `AgentSessionRegistry` class:
  - `publish(key, handle)` — sets the mapping and notifies listeners; **replaces** any previous handle under the same key (important for correction retries — same step index, new process; keeping the old one would attach the pane to a dead process).
  - `retire(key, handle)` — **identity-guarded** delete: only removes if the currently-registered handle is the exact same object reference. This guards against a race where a correction retry has already published a new handle under the same key before the old process's own exit/cleanup fires — an unguarded delete would blank a pane showing a live running step.
  - `lookup(key)` — returns the live handle or `null`.
  - `onPublished(listener)` — subscribes to publish events (a user may open the pane before the step has spawned; the workflow renders its stages immediately while the first agent takes seconds to start).
  - `liveKeys()` — insertion-order list of all currently-published keys.
- `agentSessionKey(workflowId, stepIndex): string` — `${workflowId}#${stepIndex}` composite key; composed rather than using a step id alone because the pane resolves what to render from the workflow + step index before it has loaded the step (and therefore before it has a step id).
- Deliberately **not a singleton** — same reasoning as `RuntimeRegistry`: a test needs its own instance, and a module-level singleton would leak handles between tests.

**Calls / depends on:** No internal module dependencies — pure TypeScript.

**Called from / used by:** `src/main/index.ts` (constructs the single `AgentSessionRegistry`, passes it into `WorkflowService` as `sessions`), `src/main/workflows/workflowService.ts` (`onStepProcess`/`onRuntimeEvent` callbacks publish/retire handles keyed via `agentSessionKey`).

---

### `src/main/terminal/terminalService.ts`

**Purpose:** Application-layer service backing the free-standing "open a terminal" IPC surface (distinct from the workflow-step session registry above) — spawns a shell or CLI in a project's repository directory and streams its I/O to the renderer.

**What it does:**
- `TerminalEventDataPayload { terminalId, chunk }`, `TerminalEventExitPayload { terminalId, exitCode }`.
- `TerminalServiceOptions { processes: ProcessManager, projects: ProjectService, runtimeExecutable?: (runtimeId) => string, emitData, emitExit }`.
- `TerminalService` class, holds `sessions: Map<string, ProcessHandle>`.
- `spawn(req)` — resolves the project via `projects.get(req.projectId)` (throws if not found), generates a `terminalId` (`term-<timestamp>-<random>`), resolves `cwd` (explicit `req.cwd` or the project's repository path), resolves the command: explicit `req.command`, else the runtime's resolved CLI executable (if `req.runtimeId` given and `runtimeExecutable` provided), else a platform default shell (`powershell.exe` / `bash`). Spawns via `processes.spawn(...)` with `cols`/`rows` defaults (100×30). Wires `handle.onData` → `emitData`, and `handle.completed.then(...)` → deletes the session and calls `emitExit`.
- `write(terminalId, data)` / `resize(terminalId, cols, rows)` / `kill(terminalId)` — straightforward delegations to the stored `ProcessHandle`, no-ops if the session is gone.

**Calls / depends on:** `../process/processManager` (`ProcessHandle`, `ProcessManager` types), `../projects/projectService` (`ProjectService` type).

**Called from / used by:** `src/main/index.ts` (constructs it with `processes`, `projectService`, `runtimeExecutable`, and window-broadcast `emitData`/`emitExit`), `src/main/ipc/handlers.ts` (type-only import; backs `terminal:spawn`/`write`/`resize`/`kill`).

---

## Workflows

### `src/main/workflows/workflowService.ts`

**Purpose:** The largest and most central service — orchestrates the entire lifecycle of a workflow: creating the underlying task, running the multi-role agent pipeline via `Orchestrator`, handling approval gates, question/answer resumption, and view projection for the IPC layer.

**What it does:**
- `WorkflowServiceOptions` — `db`, `projects: ProjectService`, `packetDir`, optional `worktreeRoot` (isolated per-workflow git worktrees; if absent, agents run directly against the project checkout, preserving old test-harness behavior), `registry: RuntimeRegistry`, optional `sessions: AgentSessionRegistry`, optional `emitEvent`/`emitLog` callbacks.
- Constructs and owns its own store instances: `WorkflowStore`, `EventStore`, `QuestionStore`, `DecisionStore`, `ChangeSetStore`, `PacketStore`, `BindingStore` — all against the shared `db`. Exposes getters (`getQuestionStore`, `getDecisionStore`, `getChangeSetStore`, `getWorkflowStore`) so `index.ts` can hand the **same underlying store instances** to `QuestionService`/`DecisionService`/`ChangeSetService`, avoiding two independent stores drifting.
- `running: Map<workflowId, AbortController>` — tracks in-flight executions so `cancel()` can abort them.
- `stepLogs: Map<workflowId, WorkflowLogPayload[]>` — in-memory (not persisted to DB) accumulation of step log lines, exposed via `getLogs`.
- `list(projectId)` / `get(workflowId)` / `getProjectId(workflowId)` / `getActive(projectId)` (first non-finished, non-terminal-state workflow for a project) — read/projection methods.
- `getPacket(packetRef)` — loads via `PacketStore.load`, maps to `PromptPacketView`; swallows any error to `null`.
- `start(input)` — the primary entry point for beginning a new workflow:
  - Loads the project; builds a default `Task` with `completionCriteria` conditionally including `'build'`/`'tests'` criteria based on whether the repository has those commands configured (always includes `'no-assumptions'`).
  - Persists the task as a `task.created` event inside a **DB transaction** (`db.transaction(() => {...})`), applying the event via `applyEvent` to update projections atomically.
  - Starts the workflow row via `workflows.start(...)`, fires a `workflow.started` notification.
  - Unless `input.autoRun === false`, fires `executeWorkflow(...)` **without awaiting** (`void this.executeWorkflow(...)`) — the HTTP-style IPC call returns immediately with the initial detail view while the agent pipeline runs in the background.
- `cancel(workflowId, reason?)` — aborts the running `AbortController` if any; if the workflow is already in a terminal state but not yet marked `finishedAt`, appends a `workflow.finished` event; otherwise applies the `'cancelled'` transition. Falls back to returning the current (unmodified) state on any exception.
- `resume(workflowId)` — thin/mostly no-op: returns the current detail view if not finished; **does not** actually restart execution (that only happens via `start`'s auto-run or `approveAndStartImplementation`). Possibly a stub for a not-yet-implemented resume-after-crash feature — worth confirming intent during refactor, since the name implies more than the implementation does.
- `approveAndStartImplementation(workflowId)` — enforces "Axiom A4": throws unless the project has at least one `locked` or `approved` decision. Transitions the workflow (`userApproved`), notifies `workflow.mode_transition`, then **reconstructs the domain `Task`** from the raw DB row (via Drizzle `db.select().from(tasks).where(eq(tasks.id, wf.taskId))` and `fromJson` with zod schemas for `constraints`/`completionCriteria`/`scope`/`lockedDecisionIds`) and calls `executeWorkflow` again to resume the background pipeline — the errors from that chained promise are explicitly swallowed (`.catch((_err) => { void 0 })`), which is a candidate dead-error-handling spot worth flagging.
- `answerQuestion(questionId, answer, promoteToDecision?)` — answers the question in the store; if `promoteToDecision`, creates a new locked `Decision` via `decisions.promoteFromQuestion`; then iterates **every project** (`this.options.projects.list()` — not scoped to the question's own project, a potential inefficiency/correctness smell worth flagging) looking for a workflow in `AWAITING_USER` state blocked on this question (or with no specific `blockedByQuestionId`), resumes it (`questions.apply(waiting.id, 'questionAnswered', ...)`), and re-invokes `executeWorkflow` with a **freshly reconstructed** (not stored/reloaded) `Task` object using generic placeholder text `Continue task ${waiting.taskId}` — this reconstructed task **loses the original objective and any accumulated completion criteria specificity** beyond the generic build/test defaults, which is a second candidate correctness concern for the refactor to examine.
- `executeWorkflow(projectId, workflowId, task, repositoryPath)` (private, the core engine):
  - Creates an `AbortController`, registers it in `running`.
  - Resolves `templateId` from the stored workflow row, falling back to `'feature'` if the stored value isn't a recognized `TemplateId` (handles rows from an older build or a since-removed template).
  - Captures `baseSha` via `GitService(repositoryPath).headSha()`.
  - If `worktreeRoot` is configured: creates a `WorktreeService`, calls `reclaimAbandoned()` (cleans up worktrees left behind by a crash) then `prepare(workflowId)` to get an isolated `PreparedWorktree`; `agentPath` becomes the worktree path (else falls back to `repositoryPath` directly).
  - Calls `new ClaudeTrustStore().trust(agentPath)` **before spawning any agent** — because the Claude CLI blocks at startup on a "Quick safety check" trust dialog for any directory it hasn't seen before, and every fresh worktree would trigger this every run (issues #166/#167). Failure here is non-fatal (logged/swallowed implicitly — the run proceeds and the user answers the dialog manually).
  - Builds a `GitService` against `agentPath` (not `repositoryPath`) so diffs reflect what the agents actually edited.
  - Resolves runtime bindings via `resolveBindings(projectId)` (private helper described below).
  - Constructs an `Orchestrator` with several injected callbacks:
    - `compilePacket(ctx)` — re-reads project rules/policy **per step** (not cached per-workflow, so a mid-run edit to rules takes effect on the next step), gathers answered questions and locked decisions, resolves `instructionFilenames` from the **role's bound runtime** (not a guessed/hardcoded name — axiom A6), reads repository instructions via `readRepositoryInstructions`, and calls the shared `compileContext(...)` to produce the actual `PromptPacket`.
    - `measureChange()` — diffs the worktree against `baseSha`; swallows errors to `null`.
    - `reconcileStep(report)` — calls `buildChangeSet`, records it via `this.changeSets.record(...)`, returns the reconciliation; swallows errors to `null`.
    - `verify(step, report)` — calls `verifyStep(...)` with the current project's repository config and the task's completion criteria.
    - `reviewStep(_step, _report, criteria)` — **currently a stub**: always calls `assessReview` with a hardcoded `claimedVerdict: 'pass'`, empty `findings`, and summary `'Review passed'` — i.e., there is no actual reviewer-agent-driven review assessment wired in here despite the presence of a `'reviewer'` role in bindings; worth flagging prominently, since this looks like an unfinished/placeholder implementation rather than a deliberate simplification.
    - `onQuestion` — persists the question and notifies `question.asked`.
    - `onLog` — routes to `logStep`.
    - `onStepProcess` — publishes the step's live process handle into `AgentSessionRegistry` (keyed via `agentSessionKey`), and tracks it in `liveSessions` for guaranteed retirement in `finally`.
    - `onRuntimeEvent` — renders `'tool'` and `'usage'` runtime events into the text log stream as `[TOOL] ...` / `[USAGE] ...` lines — explicitly a stopgap (comment references #152/#153: "the typed IPC channel a live view will subscribe to is #153; until it exists, surfacing tool calls as text is what makes them visible at all").
  - Calls `orchestrator.run({...})` with the resolved `template`, `bindings`, `repositoryPath: agentPath`, workflow limits (falls back to hardcoded defaults: 5 max iterations, 30min step timeout, 10min idle timeout, 4hr total timeout, 3 max retries, 5s retry delay, and `stopOn` flags defaulting mostly to `false` except `permissionViolation`/`unexpectedFileModification: true`), an `approve` callback that **always resolves `true`** (no actual human-in-the-loop gate wired at this layer beyond the earlier `approveAndStartImplementation` mode transition — worth flagging as another placeholder), and the `signal` from the abort controller.
  - `finally` block: removes from `running`, **retires every live session** (guaranteed even on throw/cancel), disposes the worktree (`worktree?.dispose()` — critical, since a worktree left behind holds a directory lock and shows up in `git worktree list` forever), and fires a final `workflow.finished` notification.
- `resolveBindings(projectId): BindingSet` (private) — reads stored bindings; for any role with no stored binding (or a binding pointing at a since-unregistered runtime id), falls back to `mock:default` (or the first registered runtime if that's absent) via `bindRole` — explicitly documented as not a silent default in intent (the Agents page is meant to show unbound roles), but the fallback exists so a fresh install remains runnable at all.
- `isSimulated(runtimeId)` (private) — returns `null` (not `false`) for an unknown/unbound runtime, distinguishing "no runtime yet" from "confirmed real" (issue #101).
- `toDetailView(wf)` (private) — the full domain-to-IPC-view projection, including per-step `simulated` flags and checkpoint/resume state.

**Calls / depends on:** `node:crypto` (`randomUUID`), `drizzle-orm` (`eq`), `zod`, `@shared/domain` (very many exports: `assessReview`, `compileContext`, schemas, `TEMPLATES`, `isTemplateId`, `FORGE_DEFAULT_RULES`, `isTerminalWorkflowState`, `resolveEffectivePolicy`, many types), `@shared/ipc` (view/payload types), `../db/connection` (`ForgeDatabase` type), `../db/eventStore` (`EventStore`), `../db/projections` (`applyEvent`), `../db/rows` (`fromJson`), `../db/schema` (`tasks`), `../db/workflowStore` (`WorkflowStore`), `../db/questionStore` (`QuestionStore`), `../db/decisionStore` (`DecisionStore`), `../db/changeSetStore` (`ChangeSetStore`), `../context/packetStore` (`PacketStore`), `../context/repositoryInstructions` (`readRepositoryInstructions`), `../git` (`GitService`, `WorktreeService`, `PreparedWorktree` type), `../evidence/changeSetBuilder` (`buildChangeSet`), `../evidence/verifier` (`verifyStep`), `../runtimes/bindings` (`bindRole`, `BindingSet`), `../db/bindingStore` (`BindingStore`), `../runtimes/claudeTrust` (`ClaudeTrustStore`), `../terminal/sessionRegistry` (`agentSessionKey`, `AgentSessionRegistry` type), `../runtimes/orchestrator` (`Orchestrator`), `../runtimes/registry` (`RuntimeRegistry` type), `../projects/projectService` (`ProjectService` type).

**Called from / used by:** `src/main/index.ts` (constructs the single instance, wires `emitEvent`/`emitLog` to broadcast over all windows), `src/main/ipc/handlers.ts` (type-only import; backs nearly all `workflow:*` and `question:answer` channels), `src/main/runtimes/accountSwitch.integration.test.ts`, `src/main/acceptance/dogfood.manual.test.ts`, `src/main/acceptance/mvpAcceptance.test.ts`.

---

## Preload

### `src/preload/api.ts`

**Purpose:** Defines `ForgeApi`, the fully explicit, named-method contract exposed to the renderer — the type-level enforcement that the renderer can never reach an arbitrary IPC channel.

**What it does:**
- A single large interface `ForgeApi` grouping methods under `app`, `dialog`, `clipboard`, `runtime`, `binding`, `project`, `rule`, `workflow`, `question`, `decision`, `changeset`, `account`, `git`, `template`, `terminal`, `provider`, plus four event-subscription methods (`onWorkflowEvent`, `onWorkflowLog`, `onTerminalData`, `onTerminalExit`), each returning an unsubscribe function.
- Every method returns `Promise<IpcResult<T>>` — an envelope, not a thrown error — because (per the file's own comment) Electron's context bridge serializes thrown errors structurally, stripping the prototype and any custom `code` property; a plain-data envelope survives the bridge intact and is unwrapped into a real error only on the renderer side (in `@renderer/ipc`).
- No generic `invoke(channel, ...)` escape hatch exists anywhere in this interface — this is the deliberate design enforcing axiom A7 at the type level.

**Calls / depends on:** `@shared/ipc` types only (a long list: `AccountView`, `AgentBindingView`, `RoleBindingsView`, `AppInfo`, `ChangedFileView`, `ChangeSetView`, `CreateProjectRequest`, `DecisionView`, `IpcResult`, `OpenQuestionView`, `ProjectDetail`, `ProjectView`, `PromptPacketView`, `RepositoryProbe`, `WorkflowDetailView`, `WorkflowEventPayload`, `WorkflowLogPayload`, `WorkflowSummaryView`, `WorkflowTemplateView`).

**Called from / used by:** `src/preload/index.ts` (implements this interface as the `api` object), `src/renderer/src/forge.d.ts` (imports the type to describe `window.forge` for the renderer's own type-checking).

---

### `src/preload/index.ts`

**Purpose:** The actual preload script — implements `ForgeApi` against `ipcRenderer.invoke` and installs it on `window.forge` via `contextBridge`.

**What it does:**
- `call<C>(channel, request): Promise<IpcResult<IpcResponse<C>>>` — a **module-private** (not exported) generic wrapper around `ipcRenderer.invoke(channel, request)`. Kept private deliberately: nothing reachable from the renderer accepts a raw channel name as an argument (this is the enforcement point for axiom A7, paired with the fully-named interface in `api.ts`).
- Implements every method of `ForgeApi` as a literal object `api`, each simply forwarding its named parameters into a `call('channel:name', { ...params })` invocation matching the shared IPC contract's channel names exactly (e.g., `project.create` → `call('project:create', request)`).
- The four event-subscription methods (`onWorkflowEvent`, `onWorkflowLog`, `onTerminalData`, `onTerminalExit`) each wrap `ipcRenderer.on(channel, handler)` in a closure that casts `payload` to the listener's expected parameter type (an unchecked cast — the boundary trust here rests on main only ever sending well-formed payloads, since these are one-way pushes rather than request/response channels validated by `invokeChannel`), and return an unsubscribe function calling `ipcRenderer.removeListener`.
- Final line: `contextBridge.exposeInMainWorld('forge', api)` — this is the **only** thing the renderer's global scope receives from main.

**Calls / depends on:** `electron` (`contextBridge`, `ipcRenderer`), `@shared/ipc` (types), `./api` (`ForgeApi` type).

**Called from / used by:** Loaded directly by Electron as the `webPreferences.preload` script (referenced in `src/main/index.ts` as `'../preload/index.cjs'`, the compiled output of this file) — not imported by any other TypeScript module.

---

## Cross-cutting notes for the refactor

A few things worth calling out explicitly since they span multiple files above:

- **Dead/unused code candidates:** `src/main/health/healthCheck.ts` (no production caller — not wired into `index.ts` startup), `src/main/logging/appLogger.ts` (`AppLogger` class never instantiated anywhere), `src/main/context/index.ts` (barrel not used — consumers import `packetStore` directly), `src/main/evidence/index.ts` (barrel not used — consumers import `changeSetBuilder`/`verifier` directly), `QuestionService.answer` (the IPC layer routes `question:answer` to `WorkflowService.answerQuestion` instead, bypassing this method).
- **Placeholder/stub logic still in the critical path:** `workflowService.ts`'s `reviewStep` callback always fabricates a hardcoded pass verdict rather than invoking a reviewer agent's actual assessment; its `approve` callback for `orchestrator.run` always resolves `true` unconditionally.
- **Provider chat/model-scan handlers** (`provider:scanModels`, `provider:chat` in `ipc/handlers.ts`) are a distinct, generic external-LLM-HTTP-client code path that bypasses the entire runtime/registry/binding abstraction used everywhere else in the app — likely worth consolidating or clearly demarcating during a refactor.
- **`answerQuestion`'s cross-project scan and task reconstruction** in `workflowService.ts` iterates every project in the system rather than scoping to the question's own project, and rebuilds a `Task` with a generic objective string that loses the original task's specifics — both flagged inline above as correctness/efficiency concerns to revisit.
- **`HostedClaudeRuntime` in `src/main/index.ts` is constructed without `hookReceiverDir`** — the fully-built and verified #169 hook mechanism is currently inert in the running app. See the note under `src/main/index.ts` above.
# Forge — Handoff Document, Part 4: `src/shared/` (domain layer + IPC contract)

`src/shared/` is Forge's environment-agnostic domain layer: pure zod schemas, pure functions, and pure types. Nothing here may import `node:*`, `electron`, or `react` — the directory compiles into `main`, `preload`, and the `renderer` alike. In practice (confirmed by grep), **`src/shared/domain/*` is consumed exclusively by `src/main`** (61 files, all importing the barrel `@shared/domain`), while **`src/renderer` only consumes `src/shared/ipc.ts`** (via the `IPC_CONTRACT` types and view schemas) and, in one file, `src/shared/app.ts`-adjacent info is actually re-declared in `ipc.ts` (`appInfoSchema`) rather than imported from `app.ts` directly. `src/shared/app.ts` itself is imported only by `src/main/ipc/handlers.ts`.

---

### `src/shared/app.ts`

**Purpose.** Minimal app-identity type shared across the process boundary.

**What it does.** Exports `APP_NAME = 'Forge'` and an `AppInfo` interface (`name`, `version`, `platform`) as a plain TypeScript interface (not a zod schema). A comment flags it as provisional: `/** Filled in properly by the hardened IPC work in #9. */` — this looks superseded, since `ipc.ts` independently defines a fuller `appInfoSchema` (adds `versions.{electron,chrome,node}`) that is what's actually used on the `app:getInfo` channel. This file's `AppInfo`/`APP_NAME` appear to be a leftover from before the IPC contract hardening in #9.

**Calls / depends on.** Nothing (no imports).

**Called from / used by.** Only `src/main/ipc/handlers.ts` (main-side). Not used by renderer. Likely dead/superseded — worth flagging for cleanup since `ipc.ts`'s `appInfoSchema`/`AppInfo` is the type actually flowing over the wire.

---

### `src/shared/ipc.ts`

**Purpose.** The single source of truth for the main↔renderer IPC boundary: every channel, its request schema, and its response schema, all as zod. This is what the preload bridge, main-process router, and renderer types are all derived from — there is deliberately no generic passthrough channel (axiom A7: an undeclared channel is unreachable).

**What it does.**
- Defines wire-level "view" schemas that mirror (but intentionally redeclare, not import) the domain shapes in `src/shared/domain/*` — e.g. `projectViewSchema`, `ruleViewSchema`, `effectiveRuleViewSchema`, `workflowStepViewSchema`, `workflowSummaryViewSchema`, `workflowDetailViewSchema`, `templateStepViewSchema`/`workflowTemplateViewSchema`, `promptPacketViewSchema`, `evidenceRefViewSchema`, `openQuestionViewSchema`, `decisionViewSchema`, `changedFileViewSchema`, `discrepancyViewSchema`, `changeSetViewSchema`, `accountViewSchema`, `agentBindingViewSchema`, `roleBindingsViewSchema`, `workflowEventPayloadSchema`, `workflowLogPayloadSchema`. The comment on `projectViewSchema` explains why: `src/shared/domain` may not be reachable from preload types, and referencing it from a wire schema would couple the wire format to an internal shape free to change.
- `repositoryProbeSchema` / `RepositoryProbeProblem` / `REPOSITORY_PROBE_CODES` — models what Forge learned probing a candidate folder to bind as a repository (`empty-path`, `not-absolute`, `missing`, `not-a-directory`, `not-a-repository`, `inside-repository`, `no-commits`, `detached-head`). Notably tracks `defaultBranch` and `defaultBranchSource` (`origin-head`/`config`/`convention`) separately from the currently checked-out `branch`, specifically to prevent conflating the two (referenced defect **#100**: a project created on a feature branch recorded that branch as default and silently changed every downstream scope verdict).
- `IPC_CONTRACT` — the big object mapping channel name → `{request, response}` zod schemas. Channels cover: `app:getInfo`, `dialog:pickDirectory`, `clipboard:writeText`, `project:*` (probeRepository/create/list/get/update/delete), `rule:set`/`rule:remove`, `workflow:*` (list/get/getActive/start/cancel/resume/approveAndStartImplementation/getPacket/exportReport/saveReport/getLogs), `runtime:list`, `binding:list`/`binding:set`, `question:list`/`get`/`answer`, `decision:list`/`get`/`propose`/`approve`/`lock`/`supersede`, `changeset:list`/`get`, `git:getWorkingDiff`/`listFiles`/`readFile`/`writeFile`, `account:enrollmentStatus`/`beginEnrollment`/`revokeEnrollment`/`list`/`register`/`updateStatus`/`remove`, `template:list`/`get`, `terminal:spawn`/`write`/`resize`/`kill`, `provider:scanModels`/`provider:chat`.
- Derived types: `IpcContract`, `IpcChannel` (union of channel names), `IpcRequest<C>`, `IpcResponse<C>`, `IPC_CHANNELS` (array of names), `isIpcChannel()` type guard.
- `IPC_ERROR_CODES` (`INVALID_REQUEST`, `INVALID_RESPONSE`, `UNKNOWN_CHANNEL`, `HANDLER_FAILED`) and the `IpcResult<T>` = `IpcSuccess<T> | IpcFailure` envelope — failures cross the boundary as data, never as a thrown `Error`, because Electron's `invoke` serialization loses the stack/cause of a rejected promise.
- Non-obvious invariants: `project:update` distinguishes an **omitted** field (leave unchanged) from an **explicit null** (clear the command) — different intents that must not collapse. `project:update` deliberately excludes `repositoryPath` — re-pointing a project at a different repo invalidates every path/diff-base/changeset recorded, so that's a new project, not an edit (**#112**). `clipboard:writeText` and `workflow:saveReport` are owned by main rather than the renderer using web APIs directly, because a packaged renderer loads from `file://`, which is not a secure context, so `navigator.clipboard` rejects (**#104**).

**Calls / depends on.** `zod` only.

**Called from / used by.** Extensively used by **both** sides:
- **main**: `src/main/ipc/handlers.ts`, `src/main/ipc/register.ts`, `src/main/ipc/router.ts` (the actual channel dispatch/validation), plus most service modules (`accountService`, `bindingService`, `changeSetService`, `decisionService`, `projectService`, `validateRepository`, `questionService`, `workflowService`, `workflowReportGenerator`) which build the `*View` response objects.
- **renderer**: `src/renderer/src/ipc.ts` (the renderer-side bridge/client), and nearly every page/component (`AgentsPage`, `ChangesPage`, `CreateProjectDialog`, `DecisionsPage`, `DefaultBranchField`, `DeleteProjectDialog`, `EditProjectDialog`, `Overview`, `projectStore`, `QuestionsPage`, `Settings`, `StatusStrip`, `StepInspector`, `WorkflowGraph`, `WorkflowPage`, `WorkflowPreflight`, `CodeViewer`, `CreateTemplateDialog`, `DecisionCard`, `DiffViewer`, `FileTree`/`fileTreeModel`, `QuestionCard`, `StartWorkflowDialog`, `WorkflowLaunchpad`).
- **preload**: `src/preload/api.ts`, `src/preload/index.ts` (bridges the contract onto `contextBridge`).

---

### `src/shared/domain/account.ts`

**Purpose.** The `Account` entity — a provider account Forge manages (issue **#44**).

**What it does.** `accountSchema` (strict object): `id` (branded `AccountId`), `provider` (opaque string — axiom A6 provider-agnosticism), `label`, `status` (`accountStatusSchema` from enums.ts), `lastUsedAt` (nullable timestamp), `createdAt`. Invariant stated in the comment: switching accounts only changes runtime credentials/active sessions, never project state, decisions, or workflow history.

**Calls / depends on.** `./enums` (`accountStatusSchema`), `./ids` (`accountIdSchema`, `timestampSchema`).

**Called from / used by.** Main only, via the barrel: `src/main/accounts/accountService.ts`, `src/main/db/accountStore.ts`.

---

### `src/shared/domain/changeset.ts`

**Purpose.** Models what the repository actually shows after a step ran — the "fact" side of axiom A3 (as opposed to an agent's claim).

**What it does.**
- `changedFileSchema` — one file's change as reported by git: `path`, `changeType` (`added`/`modified`/`deleted`/`renamed`), `previousPath` (set only for renames), `insertions`/`deletions`.
- `discrepancySchema` — a mismatch between what an agent claimed and what the repo shows; `kind` is `'claimed-but-unchanged' | 'changed-but-unclaimed' | 'outside-scope'`. This is called out as "the concrete form of axiom A3."
- `changeSetSchema` — `id`, `baseSha` (snapshot before the step), `headSha` (nullable — null while uncommitted, the normal MVP case), `files`, `patch` (the full unified diff, not a summary), `authorActor`, `stepId`, `taskId`, `correctsChangeSetId` (nullable — links a correction to what it fixed), `reviewVerdict` (nullable), `discrepancies`, `capturedAt`. Has a `.check()` invariant: **files and patch must both be present or both be absent** — a patch with no files or files with no patch means the capture broke, and treating it as a valid "empty" changeset would hide a broken diff.
- `isEmptyChangeSet(changeSet)` — true when `files.length === 0`.
- `changeSetSize(changeSet)` — sum of all insertions+deletions across files; used by the no-progress detector (issue **#29**, implemented in `guards.ts`).

**Calls / depends on.** `./enums` (`changeTypeSchema`, `verdictSchema`), `./ids` (`actorSchema`, `changeSetIdSchema`, `repoPathSchema`, `shaSchema`, `stepIdSchema`, `taskIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/db/changeSetStore.ts`, `src/main/db/schema.ts`, `src/main/evidence/changeSetBuilder.ts`, `src/main/git/gitService.ts`, `src/main/git/parse.ts`. `isEmptyChangeSet`/`changeSetSize` themselves show no direct external call sites outside the domain layer in the current grep — likely used inside `guards.ts`/orchestrator logic indirectly or reserved for a not-yet-wired no-progress check; worth double-checking during refactor whether `changeSetSize` is actually invoked anywhere.

---

### `src/shared/domain/completion.ts`

**Purpose.** Decides whether a task is **done**, from evidence rather than opinion — the machine-checkable "definition of done" engine.

**What it does.**
- Core rule stated up front: verdict per criterion is `pass | fail | unknown`, and **`unknown` is never folded into `pass`**. A criterion nobody could check is treated as the most dangerous state (absence-of-failure reading as success).
- `criterionResultSchema`/`CriterionResult` — one criterion's outcome: `kind`, `description`, `verdict`, `reason` (never empty, even on pass), `evidenceId` (nullable).
- `CompletionInput` — `task`, `evidence` (readonly `EvidenceArtifact[]`), optional `reconciliation` (`ReconcileResult`, present once diff reconciled — **#34**), optional `report` (`AgentReport`), optional `reviewVerdict`, optional `existingPaths` (supplied by caller since this module must stay pure/no filesystem access).
- `CompletionAssessment` — `verdict` (pass only when **every** criterion passed), `results`, `summary` (one line), `unknown` (criteria that couldn't be checked), `findings` (phrased for the agent that must fix them; empty on pass).
- `assessCompletion(input)` — maps `task.completionCriteria` through `evaluate()`, computing an overall verdict where **fail outranks unknown** (a real failure is actionable now; an unknown needs a different fix), and neither is a pass. A task with **zero** completion criteria yields `unknown`, not pass — enforced structurally too since `taskSchema` requires `.min(1)`.
- `evaluate()` dispatches per `CriterionKind`:
  - `build`/`tests` → `fromEvidence()`: looks for the **last** evidence artifact of that kind; missing artifact = `unknown` (never inferred as "nothing to build, therefore fine" — that's exactly the inference A3 forbids); `evidencePassed()` decides pass/fail.
  - `custom-command` → `fromCustomCommand()`: reads `params.command`, finds a matching evidence artifact by exact command string; unmatched = `unknown`.
  - `diff-scope` → `fromScope()`: consults `reconciliation.inScope`; absent reconciliation = `unknown`.
  - `no-assumptions` → `fromAssumptions()`: fails if `report.assumptions.length > 0` (rule R1); absent report = `unknown` (not a pass — absence of a report is not evidence of a clean one).
  - `reviewer-verdict` → `fromReview()`: propagates `input.reviewVerdict` (`unknown` stays `unknown`, never collapsed).
  - `file-exists` → `fromFileExists()`: checks `params.paths` against `input.existingPaths`; missing `existingPaths` (repo not inspected) = `unknown`.
- `summarise()` — renders `PASS: all N criteria met` / `FAIL: X of N criteria failed[, Y unverifiable]` / `UNKNOWN: X of N criteria could not be checked`.
- `findingFor()` — an `unknown` result is worded as a gap in verification addressed to the *system*, not the agent (the agent can't fix a criterion Forge failed to check); a `fail` is worded as a defect in the work.

**Calls / depends on.** `./enums` (`criterionKindSchema`, `verdictSchema`, `Verdict`), `./evidence` (`evidencePassed`, `EvidenceArtifact`), `./runtime` (`AgentReport`, type-only), `./task` (`CompletionCriterion`, `Task`, type-only), `./reconcile` (`ReconcileResult`, type-only).

**Called from / used by.** Main only: `src/main/evidence/verifier.ts`, `src/main/runtimes/orchestrator.ts`.

---

### `src/shared/domain/contextEngine.ts`

**Purpose.** The "context engine" — assembles the minimum-sufficient `PromptPacket` for an agent from all available project/task/decision/file state, deterministically.

**What it does.**
- Pipeline stated in the header comment: `select → rank → budget → redact` producing a deterministic, snapshottable `PromptPacket`.
- Three non-negotiable properties enforced here (not just trusted): **deterministic** (identical state → byte-identical packet, since packets are snapshotted per step and diffed across runs), **redacted** (no secrets — enforced by excluding forbidden paths *and* scrubbing every string), **locked decisions verbatim** (never truncated/summarised/dropped to fit budget — axiom A4; "if the budget cannot hold them, the budget is wrong").
- `ContextInput` — `role`, `task`, `rules` (readonly `EffectiveRule[]`), `lockedDecisions`, `files` (readonly `FileCandidate[]`), `previousAttempt` (`{summary, diffStat} | null`), `reviewFindings`, `answeredQuestions`, optional `repositoryInstructions` (the repo's own `CLAUDE.md`, already read by the caller — **#133** — kept as a string param rather than a path so this module stays pure), optional `budget` override.
- `FileCandidate` — `path` plus ranking signals: `mentionedInTask`, `recentlyChanged`, `importDistance`, `inScope` (all supplied by the caller, not computed here, again for purity).
- `ContextBudget` — `maxChars` (chars, not tokens — no model-specific tokenizer available here), `maxFiles`. `DEFAULT_BUDGET = {maxChars: 24_000, maxFiles: 40}`.
- `MAX_INSTRUCTION_CHARS = 6_000` — hard ceiling on how much of a repo's `CLAUDE.md` ever gets sent, independent of the overall budget (so a larger `maxChars` doesn't proportionally inflate an unrelated file).
- `capInstructions()` — truncates on a line boundary and appends an explicit `[Truncated by Forge: ...]` marker; never truncates mid-sentence silently.
- `ContextTrace` — what the engine did: `filesConsidered`, `filesIncluded`, `filesForbidden` (named explicitly, per A7), `filesTruncated`, `charsUsed`, `truncated`.
- `ROLE_STRATEGY` — per-role budget table: `planner` (maxFiles 12, no review findings/no previous attempt), `implementer` (25, both), `reviewer`/`tester` (15, both), `security-reviewer` (20, both), `system`/`user` (0 — Forge performs these itself, no packet ever compiled). Encoded as data (not branches) so a new role is a table entry.
- `score(candidate)` — coarse, far-apart weights: `mentionedInTask` +1000, `inScope` +100, `recentlyChanged` +50, import-distance decaying bonus (`max(0, 40 - distance*8)`). Deliberately coarse so ordering is decided by *which* signal fires, not by close arithmetic.
- `rankFiles(candidates)` — sorts by score desc, ties broken by **codepoint** path comparison (never `localeCompare`, which is host-locale-dependent and would break cross-machine snapshot comparisons).
- `compileContext(input)` — the assembly function. Fixed order: forbidden paths removed **before** ranking (a file that can never be sent must not displace one that can) → rank → take `budget.maxFiles` → measure fixed-cost content (objective, constraints, locked decisions, rules, capped instructions) → greedily fit remaining files into `maxChars`, tracking `droppedByChars` → assemble the `promptPacketSchema`-validated packet with **redaction applied to every field** via `redactSecrets()`, done **last** so nothing added earlier can slip past it.
- `truncationNotice(trace)` — user-facing note naming up to 10 omitted files when truncation occurred; null otherwise. An explicit marker rather than a silent cut, since an agent unaware its view was trimmed will confidently reason as if it saw everything.

**Calls / depends on.** `./runtime` (`promptPacketSchema`, `PromptPacket`), `./redaction` (`isForbiddenPath`, `redactSecrets`), `./enums` (`Role`, type-only), `./policy` (`EffectiveRule`, type-only), `./decision` (`LockedDecision`, type-only), `./task` (`Task`, type-only).

**Called from / used by.** Main only: `src/main/workflows/workflowService.ts`.

---

### `src/shared/domain/decision.ts`

**Purpose.** The `Decision` entity — a choice recorded once and then binding (axiom A4).

**What it does.**
- `decisionSchema` — `id`, `statement`, `rationale` (**required**, not optional — a decision without a reason can't be re-evaluated later), `status` (`decisionStatusSchema`), `proposedBy` (an agent may propose), `proposedAt`, `lockedAt`/`lockedBy` (nullable), `supersededBy` (nullable), `originQuestionId` (nullable — present when promoted from an answered question).
- `.check()` invariants (schema-level half of axiom A4; command layer in **#40** enforces the operational half):
  1. A `locked` decision must have both `lockedAt` and `lockedBy` set.
  2. **Only `'user'` may set `lockedBy`** — an agent-set `lockedBy` fails validation.
  3. `supersededBy` may only be non-null when `status === 'superseded'`.
  4. A `superseded` decision **must** name its replacement (`supersededBy` non-null).
- `lockedDecisionSchema`/`LockedDecision` — the narrower shape (`id`, `statement`, `rationale`) sent to an agent in a prompt packet — deliberately excludes status/lock metadata since the agent only needs to know it's binding, not its provenance.

**Calls / depends on.** `./enums` (`decisionStatusSchema`), `./ids` (`actorSchema`, `decisionIdSchema`, `questionIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/db/decisionStore.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/shared/domain/enums.ts`

**Purpose.** Every closed string-union ("enum") the domain switches on. String unions rather than TS `enum` so values survive JSON/SQLite/prompt-packet round trips unchanged and exhaustive `switch` statements are compile-checked (via `switch-exhaustiveness-check` lint rule).

**What it does.**
- `WORKFLOW_STATES` — `DISCOVERY, PLANNING, PLAN_READY, DECISIONS_LOCKED, IMPLEMENTING, VERIFYING, REVIEWING, CORRECTION_REQUIRED, AWAITING_USER, DONE, HALTED_LIMIT, HALTED_POLICY, CANCELLED`. `workflowStateSchema` + `WorkflowState` type.
- `TERMINAL_WORKFLOW_STATES` = `DONE, HALTED_LIMIT, HALTED_POLICY, CANCELLED` — once here, never advances again. `isTerminalWorkflowState()` checks membership.
- `decisionStatusSchema` = `proposed | approved | locked | superseded` (axiom A4 — only a user may reach `locked`, enforced in **#40**).
- `roleSchema` = `planner | implementer | reviewer | tester | security-reviewer | system | user`. `system` covers steps Forge performs itself (build, diff) which produce evidence rather than claims.
- `capabilitySchema` = `repo-read | file-write | terminal | plan | review | test` — checked when a role is bound to a runtime (**#31**).
- `RULE_SCOPES` = `global, workspace, project, workflow, agent, task` (order significant — later = more specific = wins on conflict, **#19**). `ruleScopeSchema`, `ruleScopeSpecificity(scope)` returns the array index (higher = more specific).
- `verdictSchema` = `pass | fail | unknown` — the verdict of a review or criteria evaluation.
- `reportStatusSchema` = `completed | blocked | question` — what an agent reported about its own step (reconciled against evidence in **#34**).
- `changeTypeSchema` = `added | modified | deleted | renamed` — mirrors git's status letters.
- `criterionKindSchema` = `build | tests | diff-scope | no-assumptions | reviewer-verdict | file-exists | custom-command` (**#35**).
- `ACCOUNT_STATUSES` = `connected, expired, rate_limited, disconnected` (**#44**), `accountStatusSchema`.

**Calls / depends on.** `zod` only.

**Called from / used by.** Main only (widely, via the barrel): `accountService.ts`, `bindingService.ts`, `db/bindingStore.ts`, `db/workflowStore.ts`, `decisionService.ts`, `projectService.ts`, `runtimes/scenario.ts`, `workflowService.ts`, plus many more indirectly (this is one of the most heavily depended-upon modules within `shared/domain` itself — nearly every other domain file imports from it).

---

### `src/shared/domain/event.ts`

**Purpose.** The append-only domain event envelope — the event-sourcing log Forge's read models are projected from.

**What it does.**
- `EVENT_TYPES` — the full enumerated list of event types: `project.created`, `project.updated`, `repository.bound`, `rule.set`, `rule.removed`, `binding.set`, `decision.proposed/approved/locked/superseded`, `question.asked/answered`, `task.created`, `workflow.started/transitioned/checkpointed/halted/finished`, `step.started/finished`, `changeset.captured/reviewed`, `evidence.recorded`, `account.registered/status_updated/removed`. `eventTypeSchema`, `EventType`.
- `domainEventSchema`/`DomainEvent` — `id`, `projectId`, `seq` (monotonic **per project**, assigned in the same transaction as the write — total ordering within a project without a global lock), `type`, `payload` (typed as `unknown` here deliberately — validated per-type by `eventPayloads.ts` at the command layer, keeping the envelope stable as types are added), `actor`, `reason` (nullable — "why", when not obvious from type alone), `occurredAt`.
- Invariant stated in the comment (not code-enforced here): the log is **append-only** — events are never updated or deleted, and read models must be rebuildable from events alone (asserted by a replay test in **#16**).

**Calls / depends on.** `./ids` (`actorSchema`, `eventIdSchema`, `projectIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/db/eventStore.ts`, `src/main/db/projections.ts`.

---

### `src/shared/domain/eventPayloads.ts`

**Purpose.** Per-event-type payload schemas — narrows `DomainEvent.payload: unknown` into a concrete shape per `EventType`, on both write and read.

**What it does.**
- One zod schema per event type (`projectCreated`, `projectUpdated`, `repositoryBound`, `ruleSet`, `ruleRemoved`, `bindingSet`, `decisionProposed/Approved/Locked/Superseded`, `questionAsked/Answered`, `taskCreated`, `workflowStarted/Transitioned/Checkpointed/Halted/Finished`, `stepStarted/Finished`, `changeSetCaptured/Reviewed`, `evidenceRecorded`, `accountRegistered/StatusUpdated/Removed`). Design rule stated in the header: payloads carry **what changed**, not a full entity snapshot, except where the entity *is* the thing created — a full snapshot on every edit would duplicate the tables the log is meant to explain.
- Notable non-obvious payloads:
  - `workflowTransitioned` — carries both `from` **and** `to` states, so the log reads as history (not just assertions) and an illegal transition is visible after the fact.
  - `changeSetReviewed` — carries **both** `verdict` (of record, post-override) **and** `claimedVerdict` (the reviewer's raw claim), plus `overridden: boolean`. This is because Forge can override a reviewer's PASS that the evidence contradicts (**#36**) — keeping only the final outcome would hide that the disagreement happened.
  - `evidenceRecorded` — carries the **whole** `EvidenceArtifact`, not a summary, because the log is the authority: a projection rebuilt from a summary couldn't reproduce what a reviewer actually read. (Output is capped at capture time to keep this bounded.)
- `EVENT_PAYLOADS` — the map from event type → schema.
- Compile-time coverage check: `_PayloadsCoverEveryEventType` — a conditional type that becomes `['payload map has entries that are not event types']` or `['event types missing a payload schema']` if the map and `EventType` union diverge, assigned to `_payloadCoverage: ... = true` so a mismatch is a **compile error**, not a runtime surprise.
- `EventPayloads` (mapped type: event type → inferred payload type) and `EventInput` (discriminated union of `{type, payload}` pairs) — used to type-safely construct events before the envelope is added.

**Calls / depends on.** `./event` (`EventType`, type-only), `./account`, `./changeset`, `./decision`, `./enums` (`accountStatusSchema`, `verdictSchema`, `workflowStateSchema`), `./evidence` (`evidenceArtifactSchema`), `./ids` (many id schemas), `./project` (`agentBindingSchema`, `repositorySchema`, `ruleSchema`), `./question` (`openQuestionSchema`), `./review` (`findingSchema`), `./task` (`taskSchema`), `./workflow` (`workflowCheckpointSchema`, `workflowLimitsSchema`, `workflowStepSchema`).

**Called from / used by.** Main only: `src/main/db/eventStore.ts`, `src/main/db/projections.ts`.

---

### `src/shared/domain/evidence.ts`

**Purpose.** What Forge observed when it ran a command itself — the concrete form of axiom A3 (an agent's report is a claim; this is the fact).

**What it does.**
- `runOutcomeSchema` = `completed | timeout | cancelled | spawn-failed` — separated from exit code because a run killed at its timeout may still report a stale exit code, and treating that as a verdict would turn a hang into a pass.
- `testCountsSchema` — `total/passed/failed/skipped`, all **nullable** (best-effort parse of a test runner's own output; never authoritative — these never decide a verdict, only add human-readable detail).
- `evidenceArtifactSchema`/`EvidenceArtifact` — `id`, `workflowId`, `stepId`, `kind` (`build|tests|custom-command`, matching `criterionKind`), `command` (verbatim, so reproducible by hand), `cwd`, `outcome`, `exitCode` (nullable — null is **not** a pass), `durationMs`, `stdout`/`stderr` (kept raw alongside any parsed counts, deliberately, since a silently mis-parsing parser would destroy the only record of what happened), `truncated` (output hit capture cap), `counts` (nullable), `failure` (nullable — set when `outcome !== 'completed'`), `recordedAt`.
- `.check()` invariant: a `completed` outcome must carry a non-null `exitCode`; a non-`completed` outcome must carry a non-null `failure`. This consistency is what lets `evidencePassed()` be one expression rather than a special case.
- `evidencePassed(artifact)` — `outcome === 'completed' && exitCode === 0`, and nothing else (a timeout/cancellation/spawn-failure is never a pass regardless of how encouraging output looks — this is A3 made mechanical, and deliberately a function rather than a stored boolean an agent could influence).
- `summariseEvidence(artifact)` — one line: `PASS|FAIL <kind> (<detail>, <ms>ms[, X/Y passed])`.
- `evidenceFindings(artifact)` — empty array when passed; otherwise an instruction-phrased finding with the **tail** of stdout+stderr (last 40 lines, via `lastLines()`) — tail rather than head, because a compiler prints its errors last.

**Calls / depends on.** `./ids` (`evidenceIdSchema`, `stepIdSchema`, `timestampSchema`, `workflowIdSchema`).

**Called from / used by.** Main only: `src/main/db/schema.ts`, `src/main/db/workflowStore.ts`, `src/main/evidence/commandRunner.ts`, `src/main/evidence/verifier.ts`.

---

### `src/shared/domain/forgeRules.ts`

**Purpose.** The eight default global rules (R1–R8) from `docs/FORGE_RULES.md`, encoded as code constants rather than database rows.

**What it does.**
- `DefaultRule` interface — `key`, `statement`, `scope` (`RuleScope`), `source`.
- `FORGE_DEFAULT_RULES` — array of 8 entries (`R1` through `R8`, `source: 'docs/FORGE_RULES.md'`), each at `scope: 'global'`:
  - **R1** Never guess — inspect first; "I assumed X" is a rule violation, not a report.
  - **R2** Probe before asking — a question must carry what needs deciding, why the repo couldn't answer, evidence inspected, viable options, recommendation.
  - **R3** Respect locked decisions — binding; changing one requires a change request, never a workaround.
  - **R4** Stay in scope — only permitted paths; never generated files/unapproved migrations/lockfiles (unless the task is a dependency change)/unrelated modules.
  - **R5** Report facts, structured — status/summary/files/commands/tests/open questions; assumptions must be empty.
  - **R6** Verification is not the agent's to declare — Forge runs build/tests/diff and evaluates criteria; the agent's text is a claim.
  - **R7** Never exfiltrate secrets — no reading/echoing/logging/transmitting `.env`/keys/tokens/credentials; raise a question instead.
  - **R8** Stop cleanly — leave the working tree coherent, say precisely where/why halted.
- Because these are code constants rather than DB rows, they **cannot be deleted**, only **overridden** by restating the same key at a narrower scope (visible in settings as an override). Kept in sync with `docs/FORGE_RULES.md` by a test that compares the two.
- `FORGE_DEFAULT_RULE_KEYS` — just the keys, for a test asserting no default is ever dropped.

**Calls / depends on.** `./enums` (`RuleScope`, type-only).

**Called from / used by.** Main only: `src/main/projects/projectService.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/shared/domain/glob.ts`

**Purpose.** A hand-rolled glob matcher for repository-relative POSIX paths, used to enforce scope policies (allowed/forbidden paths).

**What it does.** Deliberately **not** delegated to a dependency: `src/shared` must compile into main/preload/renderer without environment-specific imports, and the one matcher already in the tree (`picomatch`) is a *transitive* dependency of a build tool — relying on it would be a hidden coupling that breaks whenever that tool changes its own deps.
- Supported subset (each behavior explicitly measured against `picomatch` rather than recalled from memory, per the header comment):
  - `**` crosses path separators (`src/**` matches `src/a.ts` and `src/deep/b.ts`).
  - `*` does not cross separators.
  - `?` matches exactly one non-separator character.
  - A leading `**/` matches zero or more leading segments, **including zero** (`**/*.ts` matches both `a.ts` and `src/a.ts`) — flagged as the case a naive implementation misses.
  - A trailing `dir/**` matches the directory itself as well as its contents (the `/` before a trailing `**` is made optional).
- `compile(pattern)` — builds the regex by **scanning** character-by-character rather than chained `.replace()` calls, specifically to avoid a `*` inside an already-emitted `[^/]*` being rewritten by a later pass (a classic bug class for these implementations).
- `escapeLiteral()` — escapes regex metacharacters in literal path segments.
- A module-level `cache: Map<string, RegExp>` memoizes compiled patterns, since scope checks run once per changed file per step and would otherwise recompile the same handful of patterns repeatedly.
- `matchesGlob(path, pattern)` — normalizes `\` to `/` before testing (git reports POSIX paths; a path arriving from elsewhere on Windows may not be normalized).
- `matchesAny(path, patterns)` — true if any pattern matches; **empty pattern list matches nothing**.
- `firstMatching(path, patterns)` — first matching pattern, for error messages that name the specific rule that fired.

**Calls / depends on.** Nothing (pure, no imports).

**Called from / used by.** Not directly imported by any `src/main` file by name in the grep (only used *within* `src/shared/domain` — by `reconcile.ts` and `policyEngine.ts`). This is normal: consumers reach it transitively through the barrel/`reconcile`/`policyEngine` rather than importing `glob.ts` directly.

---

### `src/shared/domain/guards.ts`

**Purpose.** Loop guards — the enforceable form of axiom A5 (bounding runaway agent loops/spend). All functions are pure; the engine calls these and acts on the result, nothing here spawns/kills/waits.

**What it does.**
- `HALT_CODES` — `iteration-cap, step-timeout, idle-timeout, total-timeout, no-progress, retries-exhausted, build-failure, test-failure, permission-violation, unexpected-file-modification, open-question, provider-limit`. `haltCodeSchema`, `HaltCode`.
- `haltStateFor(code)` — maps each code to `HALTED_LIMIT` or `HALTED_POLICY`. Budget/limit exhaustion (`iteration-cap`, `step-timeout`, `idle-timeout`, `total-timeout`, `no-progress`, `retries-exhausted`, **and `provider-limit`**) → `HALTED_LIMIT`; rule violations (`build-failure`, `test-failure`, `permission-violation`, `unexpected-file-modification`, `open-question`) → `HALTED_POLICY`. Notably `provider-limit` (a provider-side rate/quota limit, **#137**) is classified as a *limit*, not a policy failure — the agent did nothing wrong and immediate retry would fail identically.
- `HaltDecision` — `{code, reason}`.
- `BudgetState` — `iteration`, `elapsedMs` (total wall clock), `stepElapsedMs` (nullable), `stepIdleMs` (nullable).
- `checkBudgets(state, limits)` — checks in a **deliberate order**: total timeout first, then iteration cap, then step timeout, then idle timeout — so a workflow past its overall deadline reports *that*, not whichever step happened to be running when the deadline passed.
- `remainingBudget(state, limits)` — `iterationsLeft`/`totalMsLeft`/`stepMsLeft`, all floored at 0 (never negative — "-1 iterations left" is meaningless to a user).
- `FAILURE_KINDS` = `transient | semantic`. `FailureKind`. The key distinction: transient = same request could plausibly succeed unchanged (crash, dropped connection); semantic = it could not (bad credentials, policy violation, twice-invalid report). Retrying a semantic failure "spends the budget on a certainty."
- `decideRetry(kind, attemptsUsed, limits)` — semantic never retries; transient retries up to `limits.maxRetries` with a **fixed** (not exponential) backoff (`limits.retryDelayMs`) — deliberate, since a single workflow retries its own step against a local CLI, not many clients contending for a shared resource.
- `fingerprintChange(files, patch)` — a fingerprint of what an iteration actually changed, built from the **diff**, not the agent's report (to catch an agent resubmitting identical work while describing it differently). File list is sorted before hashing so file-order jitter doesn't fake "progress." Patch text is hashed in too (line-count-only fingerprints would treat "41→42" and "41→43" as the same shape).
- `hash(value)` — small FNV-1a string hash (not cryptographic — deliberately, since this only compares Forge's own consecutive diffs, and using `Math.imul` for exact 32-bit multiplication). Chosen over `node:crypto` to keep the module pure/renderer-usable.
- `detectNoProgress(fingerprints)` — halts (`no-progress`) only when the **last two consecutive** fingerprints are identical; two identical diffs separated by a different one in between is not flagged (something else was tried, even if reverted).
- `StepOutcomeSignals` — `buildFailed`, `testsFailed`, `hasOpenQuestion`, `permissionViolated`, `modifiedUnexpectedFiles`.
- `checkStopConditions(signals, limits)` — applies the project's "stop-on" toggles. **`permissionViolated` always halts regardless of configuration** — A7 is not a preference; the schema in `workflow.ts` types that field as literal `true` rather than `boolean`, and this is the runtime-side enforcement of the same guarantee.
- `formatDuration(ms)` — human-readable duration (`Xh Ym`, `Xm`, `Xs`).

**Calls / depends on.** `zod`, `./workflow` (`WorkflowLimits`, type-only).

**Called from / used by.** Main only: `src/main/runtimes/orchestrator.ts` (the only direct consumer of `checkBudgets`/`detectNoProgress`/`fingerprintChange`/`haltStateFor`; other exports like `checkStopConditions`/`decideRetry`/`remainingBudget` did not show direct hits outside the domain layer in this grep pass — worth double-checking wiring during refactor).

---

### `src/shared/domain/ids.ts`

**Purpose.** Branded (nominal) identifier types for every entity, plus a few other primitive branded/refined types (`Timestamp`, `RepoPath`, `Sha`, `Actor`).

**What it does.**
- `id<Brand extends string>()` — a generic helper returning `z.uuid().brand<Brand>()`. Uses an eslint-disable for `no-unnecessary-type-parameters` since the brand parameter is used only in the return type, which is precisely the mechanism intended (there's no runtime value to infer the brand from).
- Branded id schemas: `projectIdSchema`, `repositoryIdSchema`, `ruleIdSchema`, `agentBindingIdSchema`, `decisionIdSchema`, `questionIdSchema`, `taskIdSchema`, `workflowIdSchema`, `stepIdSchema`, `changeSetIdSchema`, `evidenceIdSchema`, `eventIdSchema`, `accountIdSchema` — all UUIDs, structurally identical but nominally distinct, so passing a `TaskId` where a `WorkflowId` is expected is a **compile** error.
- `timestampSchema` = `z.iso.datetime()` — deliberately a string, not `Date`: `Date` survives Electron's structured clone but **not** the JSON round trip used for prompt packets and event payloads — one representation everywhere avoids "works in main, breaks in the packet" bugs.
- `repoPathSchema` — a repository-relative POSIX path: refined to reject backslashes (must use `/` even on Windows, since these are compared against git output and glob rules) and to reject absolute paths (leading `/` or a Windows drive letter like `C:`).
- `shaSchema` — regex `^[0-9a-f]{7,40}$`, accepting both abbreviated and full SHA-1 hex.
- `actorSchema` — a union: literal `'user'`, literal `'system'`, or a template-literal `agent:<id>` — present on every event, letting an agent's claim be checked against what actually happened (A3) while remaining attributable to a specific runtime.

**Calls / depends on.** `zod` only.

**Called from / used by.** Main only, pervasively, via the barrel (effectively every domain and store file transitively depends on this module since nearly all entity schemas use these ids).

---

### `src/shared/domain/index.ts`

**Purpose.** The barrel/public API of `src/shared/domain` — re-exports every schema, type, and function that other files (all in `src/main`) are meant to import via `from '@shared/domain'`.

**What it does.** A large, purely re-export file with no logic of its own. Header comment restates the two invariants for everything under this directory: no provider-specific fields anywhere (axiom A6 — runtime/account ids are opaque strings), and no environment imports (must compile into main, preload, and renderer). Re-exports from every sibling file: `ids.ts`, `enums.ts`, `account.ts`, `project.ts`, `decision.ts`, `question.ts`, `task.ts`, `workflow.ts`, `changeset.ts`, `evidence.ts`, `completion.ts`, `review.ts`, `event.ts`, `eventPayloads.ts`, `policy.ts`, `forgeRules.ts`, `runtime.ts`, `protocol.ts`, `transitions.ts`, `guards.ts`, `limitRules.ts`, `redaction.ts`, `contextEngine.ts`, `template.ts`, `glob.ts`, `reconcile.ts`, `policyEngine.ts`, `permissionMode.ts`, `rolePermission.ts`.

**Calls / depends on.** All 27 other files in `src/shared/domain/`.

**Called from / used by.** This **is** what all 61 `src/main` consumer files import (`from '@shared/domain'`). No `src/renderer` file imports it (renderer only touches `@shared/ipc`). Essentially every service, store, evidence/git/runtime module in main goes through this single barrel rather than importing domain submodules directly — a refactor that reorganizes submodules should keep this barrel's export surface intact, or update every one of the 61 consumers.

---

### `src/shared/domain/limitRules.ts`

**Purpose.** Resolves `WorkflowLimits` (iteration/timeout/retry bounds) through the same rules-inheritance mechanism as ordinary policy rules, so limits can be configured per-scope (global→workspace→project→workflow→agent→task) and appear with provenance in a settings screen, rather than via a separate, parallel settings system.

**What it does.**
- Rule keys are namespaced under `limit.` — e.g. `limit.maxIterations`, `limit.stepTimeoutMs`, `limit.idleTimeoutMs`, `limit.totalTimeoutMs`, `limit.maxRetries`, `limit.retryDelayMs`, `limit.stopOn.buildFailure`, `limit.stopOn.testFailure`, `limit.stopOn.openQuestion`, `limit.stopOn.unexpectedFileModification`. A rule's `statement` is its value as text (reusing the same `Rule` mechanism that serves prose rules like "never modify migrations").
- `LimitRuleProblem` — `{key, value, detail}` — a limit rule that couldn't be parsed; surfaced, never silently swallowed (a rule meant to cap iterations at 3 but typed "three" must not quietly run at the schema default).
- `ResolvedLimits` — `{limits, overrides, problems}`.
- `NUMERIC_KEYS` / `TOGGLE_KEYS` — the known `limit.*` suffixes and what they map to.
- `resolveLimits(rules)` — runs `resolveEffectivePolicy()` first (same precedence code as every other rule type), then parses each `limit.*` entry: rejects `Number('')` (which JS coerces to `0`) and `NaN`/non-integer values explicitly rather than silently accepting a limit of zero; rejects toggle values that aren't exactly `"true"`/`"false"`; flags any unrecognized `limit.*` key as a probable typo (rather than silently doing nothing). Final candidate object is validated against `workflowLimitsSchema`; a schema-level failure (e.g., a numeric value that's out of range) degrades to `workflowLimitsSchema.parse({})` (the defaults) rather than yielding an unrunnable workflow.
- `limitRuleKey(field)` — the canonical rule key for a given limit field, so a settings screen writes the same key this function reads.

**Calls / depends on.** `zod`, `./policy` (`resolveEffectivePolicy`, `ResolvableRule`), `./workflow` (`workflowLimitsSchema`, `WorkflowLimits`).

**Called from / used by.** **Nothing outside `limitRules.ts` and its own test file.** Grep across all of `src/main` and `src/renderer` found zero call sites for `resolveLimits`/`limitRuleKey`. It is exported from the barrel (`index.ts`) but appears entirely unwired — the settings/limits configuration described in its own doc comment does not appear to be hooked up anywhere yet. **Flag this as dead/unfinished code** for the refactor — either it's a feature that was designed but never connected to `workflowService.ts` (which currently seems to consult `workflow.limits` directly rather than resolving `limit.*` rules), or it should be removed.

---

### `src/shared/domain/permissionMode.ts`

**Purpose.** The CLI permission mode a spawned agent runtime is given — controls whether/how much it can act without prompting.

**What it does.**
- `permissionModeSchema` = `manual | plan | auto | acceptEdits | bypassPermissions`, ordered most-to-least cautious. Backstory in the comment: dogfood run **#130** halted in 25 seconds because no mode was passed, so the CLI denied every tool call.
- `DEFAULT_PERMISSION_MODE = 'acceptEdits'` — chosen because it's the weakest mode in which a workflow can actually complete; Forge's own guards (scope enforcement, diff reconciliation, its own build/test runs) are what make an unattended edit safe, not the CLI's own prompting.
- `PERMISSION_MODE_DESCRIPTIONS` — a `Record<PermissionMode, string>` for rendering in a settings screen without the user having to guess (e.g. `manual: 'Always ask before making changes'`).

**Calls / depends on.** `zod` only.

**Called from / used by.** Main only: `src/main/runtimes/antigravityCliRuntime.ts`, `src/main/runtimes/claudeCliRuntime.ts`, `src/main/runtimes/hostedClaudeRuntime.ts`.

---

### `src/shared/domain/policy.ts`

**Purpose.** Pure rule-resolution engine: merges rules declared at every scope into one "effective policy," most-specific-scope-wins.

**What it does.**
- `ResolvableRule` — the structural subset of a rule resolution actually needs (`scope`, `key`, `statement`, `source`) — deliberately **not** the full `Rule` type, so both a stored rule (branded id + timestamp) and a code-defined default (`FORGE_DEFAULT_RULES`, neither) resolve through the same function without a second merge path.
- `EffectiveRule` — one resolved rule (`key`, `statement`, `scope`, `source`) plus `shadowed: readonly ShadowedRule[]` — the rules with the same key that **lost**, widest-first. Kept (not discarded) specifically so a settings screen can show "this rule is being overridden" — a silent override is how a global safety rule disappears unnoticed.
- `isOverridden(rule)` — true when `shadowed.length > 0`.
- `resolveEffectivePolicy(rules)` — groups by `key`, sorts each group's candidates by scope specificity (`compareByScope`, tie-broken by `source` via codepoint comparison for full determinism even with in-memory duplicates), takes the **last** (most specific) as the winner. Result is sorted by `key` via **codepoint** comparison (never `localeCompare`, since this feeds a prompt packet that's snapshotted/diffed across machines and CI). Input array order is irrelevant — only each rule's `scope` decides precedence.
- `compareCodepoint(left, right)` — helper for stable ordering.
- `formatPolicyForAgent(policy)` — renders the resolved policy as `1. <statement>\n2. ...` — **without scope labels**, deliberately: an agent told a rule came "only" from a project (vs. global) might treat it as negotiable.
- `POLICY_SCOPES` — re-export of `RULE_SCOPES`, so a settings screen can render the inheritance chain without importing the enum module directly.

**Calls / depends on.** `./enums` (`RULE_SCOPES`, `ruleScopeSpecificity`, `RuleScope`).

**Called from / used by.** Main only: `src/main/projects/projectService.ts`, `src/main/workflows/workflowService.ts`. Also depended on internally by `limitRules.ts` (`resolveEffectivePolicy`).

---

### `src/shared/domain/policyEngine.ts`

**Purpose.** Enforces axiom A7 (least privilege) as a hard boundary, not a prompt: evaluates commands, file writes, and role capabilities against the permissions granted in an `AgentBinding` and global safety rules. Header comment states the thesis directly: "Prompts are suggestions. The policy engine is a boundary."

**What it does.**
- `policyViolationKindSchema` = `unpermitted-write | forbidden-path | dangerous-command | unpermitted-command | secret-exfiltration`. `policyViolationSchema`/`PolicyViolation` = `{kind, culprit, detail}`.
- `DangerousCommandPattern` — `{pattern: RegExp, name, reason}`.
- `DANGEROUS_COMMANDS` — a hardcoded array of regexes, **blocked regardless of role**: `git push --force`/`-f`/`+branch` (force-push), `git reset --hard`, `git clean -f*` (force clean), `git branch -D`/`-M` (force delete/rename), `rm -r` targeting root/wildcard/home/relative-root, `npm|yarn|pnpm publish`, and piping `curl|wget` output into a shell interpreter.
- `assessCommandPolicy(command, permissions)` — checks a raw command string: dangerous patterns first (hard block), then git *write* operations (`commit|push|merge|rebase|tag|cherry-pick` — Forge manages git history itself, agents may never commit/push directly), then test-runner commands gated on `permissions.runTests`, then build commands gated on `permissions.runBuild`.
- `StepPolicyInput` — `binding` (`AgentBinding`), `report` (`AgentReport`), optional `forbiddenPaths`, optional `changedPaths` (paths **actually** measured from the repository, per **#144** — when supplied, the write-permission check is reconciled against this measurement rather than trusting the agent's own `filesChanged` claim wholesale, because a read-only role naming a file it merely *read* — e.g. a reviewer discussing changed files — is a predictable false alarm otherwise; `changedPaths` undefined falls back to the conservative reading of trusting the claim, which can over-halt but never lets an unpermitted write through unnoticed).
- `assessStepPolicy(input)` — three checks: (1) file-write permission (reconciled against `changedPaths` when available, as above); (2) path boundaries — every claimed changed file checked against `isForbiddenPath()` (R7, secret paths) and against `forbiddenPaths` glob list (R4); (3) every `report.commandsRun` entry run through `assessCommandPolicy()`.
- `formatPolicyHaltReason(violations)` — renders a bulleted human-readable halt reason.

**Calls / depends on.** `zod`, `./project` (`AgentBinding`, `Permissions`, type-only), `./runtime` (`AgentReport`, type-only), `./glob` (`matchesAny`), `./redaction` (`isForbiddenPath`).

**Called from / used by.** Main only: `src/main/runtimes/orchestrator.ts`.

---

### `src/shared/domain/project.ts`

**Purpose.** The `Project`, `Repository`, `Rule`, `Permissions`, and `AgentBinding` entities — the core project/configuration data model.

**What it does.**
- `repositorySchema`/`Repository` — `id`, `absolutePath` (the **one** place in the domain a native filesystem path appears — everything downstream is repo-relative so scope globs/prompt packets stay portable), `defaultBranch`, `buildCommand`/`testCommand` (verbatim shell commands **Forge runs itself**, nullable — never guessed/detected, since a wrong guess would violate axiom A2 and produce evidence that only *looks* real, per **#33**), `tech` (free-form tags used by the context engine for file ranking).
- `ruleSchema`/`Rule` — `id`, `scope`, `key` (stable — lets a narrower scope override the same concern), `statement`, `source`, `createdAt`. Distinct from a `Decision`: a rule is ongoing ("never modify migrations"), a decision is a one-time choice.
- `permissionsSchema`/`Permissions` — `readFiles` (default true), `writeFiles`/`runTests`/`runBuild`/`installPackages`/`gitWrite`/`network` (all default **false** — opt-in, so a new permission never silently applies to an existing binding), `gitRead` (default true). `gitWrite` is explicitly noted off for MVP — "the final commit is the user's call."
- `agentBindingSchema`/`AgentBinding` — `id`, `role`, `runtimeId` (opaque string — axiom A6, the domain must not know Claude/Antigravity exist), `accountId` (nullable, opaque), `capabilities` (declared by the runtime, checked against the role at bind time, **#31**), `permissions`.
- `projectSchema`/`Project` — `id`, `name`, `repository`, `createdAt`, `updatedAt`.

**Calls / depends on.** `./enums` (`capabilitySchema`, `roleSchema`, `ruleScopeSchema`), `./ids` (`agentBindingIdSchema`, `projectIdSchema`, `repositoryIdSchema`, `ruleIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/db/bindingStore.ts`, `src/main/db/projectRepository.ts`, `src/main/db/ruleRepository.ts`, `src/main/db/schema.ts`, `src/main/runtimes/bindings.ts`.

---

### `src/shared/domain/protocol.ts`

**Purpose.** The wire protocol between Forge and an agent process — Forge renders a `PromptPacket` to text, the agent replies with a fenced JSON report, and this module extracts/validates that report before anything downstream sees it. Header comment: this "replaces the user as the message bus"; agents never talk to each other in prose.

**What it does.**
- `REPORT_BEGIN = 'FORGE_REPORT_BEGIN'`, `REPORT_END = 'FORGE_REPORT_END'` — deliberately distinctive sentinels rather than a bare ` ```json ` fence, since agents emit generic code fences constantly for unrelated purposes; a distinctive sentinel is unambiguous to search for even inside model commentary (which rule R5 all but guarantees will surround it).
- `protocolErrorCodeSchema` = `no-report | unterminated-report | invalid-json | schema-violation`.
- `ProtocolFailure`/`ProtocolSuccess`/`ProtocolResult` — `{ok:false, code, message}` or `{ok:true, report}`.
- `parseAgentReport(output)` — finds `REPORT_BEGIN`... then the **last** occurrence of `REPORT_END` (so a report whose own content quotes the sentinel — which happens, per the comment — still parses correctly) ... strips an optional ` ```(json)? ` fence around the body (models add one reflexively even when told not to; stripping it avoids burning a retry on formatting rather than substance) ... `JSON.parse()`s it ... validates against `agentReportSchema`. Failure at each stage returns a distinct error code with a message specifically written to be fed back to the agent verbatim on re-prompt.
- `reportVerdictSchema` = `accept | await-user | halt-assumption | halt-blocked`.
- `assessReport(report)` — decides what a *structurally valid* report means for the workflow. **Ordering matters**: assumptions are checked **before** status, so an agent claiming `status: completed` while also listing a non-empty `assumptions[]` is halted (`halt-assumption`), not accepted — this exact combination is "precisely how rule R1 gets violated in practice." Then dispatches on `status`: `question` with empty `openQuestions` → `halt-blocked` (nothing to route); `question` with entries → `await-user`; `blocked` → `halt-blocked`; `completed` → `accept` (worded carefully: "the claims are now checked against the repository," not "the step is done").
- `renderPromptPacket(packet)` — renders a `PromptPacket` into the actual text sent to the agent. Sections omitted entirely when empty (packets are snapshotted/diffed per step; a wall of empty headings obscures real changes). Fixed section order for minimal diffs: ROLE, OBJECTIVE, CONSTRAINTS, RULES, PROJECT INSTRUCTIONS (repo's own `CLAUDE.md` — deliberately kept separate from Forge's RULES section and never names which file/provider read it, per axiom A6/**#133**, so the agent doesn't conflate house style with enforced policy), LOCKED DECISIONS, YOU MAY MODIFY, YOU MAY NOT MODIFY, RELEVANT FILES, PREVIOUS ATTEMPT, REVIEW FINDINGS TO ADDRESS, ANSWERED QUESTIONS, HOW COMPLETION IS JUDGED, then (conditionally) a hard **"YOU MAY NOT MODIFY ANY FILE"** section for any role whose `ROLE_REQUIRED_CAPABILITIES` doesn't include `file-write` — derived from the role rather than hardcoded per template, specifically because dogfood run **#130** found a planner correctly-but-uselessly fixing the bug it was asked only to plan, and the workflow then refused the (correct) work since it violated an unstated constraint. The comment explains **why no CLI permission mode alone expresses this**: `plan` mode ends by requesting approval instead of replying (a headless run can't give it), `manual` waits forever for an approval nobody answers, `auto` just permits the edit — so the constraint has to be stated in the packet and enforced by Forge itself. Then `REPORT_INSTRUCTIONS`, and finally (last, deliberately, since it corrects the reply) `packet.correction` if present. **This is the exact function whose output was found this session (via #169 diagnosis) to be truncated by an undermarked "paste" heuristic in the hosted Claude CLI when delivered via a single unmarked write() — the fix landed in `interactiveTurn.ts`'s `promptKeystrokes()`, not in this file itself, since this file's job (render the text) was already correct.**
- `bullets()`/`numbered()` — simple list renderers.
- `REPORT_INSTRUCTIONS` — the literal reply-format text sent to every agent, written as a **filled-in example** rather than an abstract schema description (models reproduce a seen shape more reliably than one inferred from field descriptions), with an emphatic note that `assumptions` **must** be empty.

**Calls / depends on.** `zod`, `./runtime` (`agentReportSchema`, `ROLE_REQUIRED_CAPABILITIES`, `AgentReport`, `PromptPacket`), `./enums` (`Capability`, type-only).

**Called from / used by.** Main only, heavily: `src/main/runtimes/antigravityCliRuntime.ts`, `src/main/runtimes/claudeCliRuntime.ts`, `src/main/runtimes/claudeStream.ts`, `src/main/runtimes/exchange.ts`, `src/main/runtimes/hostedClaudeRuntime.ts`, `src/main/runtimes/orchestrator.ts`, `src/main/runtimes/scenario.ts` — i.e. essentially every runtime adapter plus the orchestrator.

---

### `src/shared/domain/question.ts`

**Purpose.** The `OpenQuestion` entity — a question an agent could not answer from the repository itself (axiom A2), with its shape structurally enforcing "probe before asking" (rule R2).

**What it does.**
- `evidenceRefSchema`/`EvidenceRef` — `path`, `line` (nullable, positive int), `note` (what the agent concluded from this file — why it wasn't enough). Preferring `path:line` over a bare path lets the user jump straight to what the agent saw (**#39**).
- `openQuestionSchema`/`OpenQuestion` — `id`, `question`, `whyUndetermined`, `evidence` (**`.min(1)`** — non-empty by construction, so a question that skipped investigation literally cannot be constructed), `options`, `recommendation` (nullable), `askedBy`, `askedAt`, `answer` (nullable), `answeredAt` (nullable), `answeredBy` (**typed as `z.literal('user').nullable()`** — only ever `'user'`; no agent, including the one that asked, may answer a question).
- `.check()` invariants:
  1. `answer !== null` must exactly coincide with `answeredAt !== null` (both set or both null).
  2. Same for `answeredBy`.
  3. If `recommendation` is set and `options` is non-empty, `recommendation` **must** be one of the listed `options`.
- `isAnswered(question)` — `answer !== null`.

**Calls / depends on.** `zod`, `./ids` (`actorSchema`, `questionIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/db/questionStore.ts`, `src/main/db/schema.ts`.

---

### `src/shared/domain/reconcile.ts`

**Purpose.** Reconciles what an agent **claimed** it changed against what the repository **actually** shows (real `git diff`) and against the task's scope policy — the mechanical implementation of axiom A3 for file changes specifically.

**What it does.**
- `ReconcileInput` — `claimed` (readonly string[], untrusted), `actual` (readonly `ChangedFile[]`, the fact), `scope` (`ScopePolicy`).
- `ReconcileResult` — `discrepancies`, `outOfScope` (paths edited outside policy — **a policy halt, not merely a review finding**), `claimAccurate` (claim matches reality exactly — says nothing about scope), `inScope` (nothing edited outside policy).
- Both mismatch directions matter for different reasons: **claimed-but-unchanged** suggests the work wasn't done (the "liar" scenario); **changed-but-unclaimed** suggests the agent doesn't know what it did, which is judged *worse* than lying. Scope is orthogonal to honesty.
- `isPathAllowed(path, scope)` — `forbiddenPaths` checked **first and wins**. Empty `allowedPaths` means "anywhere not forbidden."
- `scopeRefusalFor(path, scope)` — names *which* rule refused a path.
- `reconcile(input)` — normalizes both claimed and actual paths (`\`→`/`) before comparing. Computes `outOfScope` first; then `changedButUnclaimed` and `claimedButUnchanged`, **excluding** anything already flagged `outOfScope` from either. Discrepancies list is ordered: out-of-scope, then changed-but-unclaimed, then claimed-but-unchanged, each sub-sorted by path. `claimAccurate` is computed from the **unfiltered** path sets.
- `shouldHalt(result)` — **only** a scope violation halts (`!result.inScope`); a dishonest-but-in-scope claim is *not* a halt, it's a **review finding**.
- `summariseDiscrepancies(result)` — counts per kind, joined into one line; null if no discrepancies.
- `correctionFindings(result)` — only the honesty discrepancies (excludes `outside-scope`).
- `normalise(path)` / `byPath(left, right)` — helpers.

**Calls / depends on.** `./glob` (`firstMatching`, `matchesAny`), `./changeset` (`ChangedFile`, `Discrepancy`, type-only), `./task` (`ScopePolicy`, type-only).

**Called from / used by.** Main only: `src/main/evidence/changeSetBuilder.ts`, `src/main/runtimes/orchestrator.ts`, `src/main/runtimes/scenario.ts`.

---

### `src/shared/domain/redaction.ts`

**Purpose.** Secret redaction by value shape — a shared implementation used both for process output on its way to a log and for a prompt packet on its way to an agent, so the two can't drift.

**What it does.**
- `REDACTION = '[redacted]'`.
- `VALUE_PATTERNS` — ordered regex list, longer/more-specific forms first: `bearer|basic <token>` auth headers; `KEY=value`/`KEY: value` where the key name looks secret; PEM private-key blocks (multi-line); JWTs; credential-bearing URLs (`scheme://user:pass@host`).
- `redactSecrets(text)` — applies each pattern in order via `.replace()`. Two special cases: (1) URL-credential case checked **first** within the replacer, because the generic `KEY: value` branch would otherwise mangle the line; (2) the key name is preserved and only the value is replaced. Deliberately over-redacts sometimes.
- `FORBIDDEN_PATH_PATTERNS` — whole-file exclusions: `.env` variants, key/cert extensions, SSH private keys, cloud/tool credential directories, `credentials*`, `.npmrc`, `.netrc`, `secrets*`.
- `isForbiddenPath(path)` — normalizes backslashes, tests against `FORBIDDEN_PATH_PATTERNS`.

**Calls / depends on.** Nothing (pure, no imports).

**Called from / used by.** Main only: `src/main/evidence/commandRunner.ts`, `src/main/logging/appLogger.ts`, `src/main/process/index.ts`, `src/main/process/redact.ts`. Also depended on internally by `contextEngine.ts` and `policyEngine.ts`.

---

### `src/shared/domain/review.ts`

**Purpose.** Models a reviewer's output and — critically — the asymmetric rule that **Forge, not the reviewer, decides the verdict of record.**

**What it does.**
- Core asymmetry: reviewer says FAIL → believed outright; reviewer says PASS → checked against evidence and **overridden** if any completion criterion is failing.
- `findingSeveritySchema` = `blocker | major | minor | nit`. `REJECTING` = `Set(['blocker', 'major'])`.
- `findingSchema`/`Finding` — `severity`, `file` (nullable), `line` (nullable), `issue`, `requiredChange` (separate field, feeds directly into the correction task's constraints).
- `reviewReportSchema`/`ReviewReport` — `changeSetId` (required), `stepId`, `claimedVerdict`, `findings`, `summary`, `reviewedAt`. `.check()`: a `fail` claimedVerdict with **zero** findings is rejected.
- `ReviewOutcome` — `verdict` (of record), `overridden` (bool), `reason`, `rejectingFindings`, `corrections`.
- `assessReview(report, criteria)` — the override logic:
  1. `claimedVerdict === 'pass'` but some completion criteria are `fail` → verdict **overridden to `fail`**.
  2. `claimedVerdict === 'pass'` but some criteria are `unknown` → verdict **overridden to `unknown`**.
  3. `claimedVerdict === 'pass'` but there are rejecting (blocker/major) findings anyway → verdict **overridden to `fail`**.
  4. `claimedVerdict === 'fail'` → taken at face value, **all** findings travel into `corrections`.
  5. `claimedVerdict === 'unknown'` → taken at face value.
  6. Otherwise → `pass`, `overridden: false`.
- `correctionConstraints(originalConstraints, outcome)` — builds a correction task's constraints as `[...original, ...outcome.corrections, 'Fix only what the findings name...']`.
- `instructionFor(finding)` — renders `[severity] (file:line) issue — requiredChange`.
- `bySeverity()` — orders by an explicit `SEVERITY_ORDER` index.

**Calls / depends on.** `zod`, `./enums` (`verdictSchema`, `Verdict`), `./ids` (`changeSetIdSchema`, `repoPathSchema`, `stepIdSchema`, `timestampSchema`), `./completion` (`CriterionResult`, type-only).

**Called from / used by.** Main only: `src/main/workflows/workflowService.ts`. (**Note:** `workflowService.ts`'s `reviewStep` callback is currently a **hardcoded stub** — see Part 3 of this handoff — so `assessReview` is called there today with a fabricated always-pass claim, not a real reviewer agent's output.)

---

### `src/shared/domain/rolePermission.ts`

**Purpose.** Decides which CLI `PermissionMode` a given role/binding combination should run under, and records why — because a hosted interactive session can be *asked* for permission, but the headless path used by Forge never can (a real turn under `acceptEdits` was measured — **#166/#173** — running its tools and then hanging forever on an interactive "Do you want to proceed?" prompt nobody was there to answer).

**What it does.**
- `RolePermission` — `{mode: PermissionMode, reason: string}`.
- `permissionForRole(role, mayWriteFiles)`:
  - If `!mayWriteFiles` → mode `'plan'`.
  - Else → mode `'bypassPermissions'`, with the reasoning documented at length: the sandbox and Forge's own subsequent reconciliation (diff measurement, scope enforcement, build/test runs) are the actual safety boundary — every step runs in a **disposable git worktree**, never the user's checkout. Explicitly frames this as the "blunt instrument," with surfacing the prompt to the user instead tracked as **#173**.
  - Precedence: **the binding's permission wins over the role's default.**

**Calls / depends on.** `./permissionMode` (`PermissionMode`, type-only), `./enums` (`Role`, type-only).

**Called from / used by.** Main only: `src/main/runtimes/orchestrator.ts`.

---

### `src/shared/domain/runtime.ts`

**Purpose.** The runtime contract (`IAgentRuntime`) — the **only** thing the application layer is allowed to know about an agent provider (axiom A6 lives here). Also defines `PromptPacket` (what's sent to an agent) and `AgentReport` (what an agent claims back).

**What it does.**
- `runtimeIdSchema` (branded string), `sessionIdSchema` (branded string) — opaque identifiers; core validates only that an id is *registered*, never enumerates providers.
- `promptPacketSchema`/`PromptPacket` — `role`, `objective`, `constraints`, `rules`, `lockedDecisions` (A4), `allowedPaths`/`forbiddenPaths`, `relevantFiles` (a hint, not a restriction), `reviewFindings`, `previousAttempt` (`{summary, diffStat} | null`), `completionCriteria`, `answeredQuestions`, `repositoryInstructions` (nullable — the repo's own `CLAUDE.md`; present because the spawned CLI runs with `--safe-mode` which disables its own file-loading — **note this is now stale for the hosted runtime, which runs WITHOUT `--safe-mode`**, per Part 1 of this handoff), `correction` (nullable — lives **on** the packet rather than passed alongside it, per **#135**).
- `agentReportSchema`/`AgentReport` — `status`, `summary`, `filesChanged`, `commandsRun`, `testsRun`, `openQuestions` (same `.min(1)` evidence invariant as `question.ts`), `assumptions` (must be empty — rule R1).
- `hasDisqualifyingAssumptions(report)` — `assumptions.length > 0`.
- `runtimeSessionStateSchema` = `starting | idle | working | completed | failed | cancelled`.
- `runtimeStatusSchema` — `sessionId`, `state`, `failure` (nullable), `lastActivityAt`.
- `runtimeEventSchema` — discriminated union on `type`: `chunk`, `tool`, `state`, `result`, `usage` (**#137**), `error` (`message`, `retryable`, `providerLimit` — **#137**).
- `SessionOptions` — `repositoryPath`, `role`, optional `accountId`, `permissionMode`, `timeoutMs`, `resumeKey` (`{workflowId, stepIndex, iteration}`), `onProcess` (**#170**).
- `SessionHandle` — `{sessionId, runtimeId}`.
- `IAgentRuntime` interface — `id`, `capabilities`, `simulated` (**#101**), `supportsAccountIsolation` (**#111**), `instructionFilenames`, and methods `start()`, `send()`, `events()` (async iterable), `status()`, `cancel()`, `dispose()`.
- `ROLE_REQUIRED_CAPABILITIES` — per-role capability set.
- `canHoldRole(capabilities, role)` / `missingCapabilities(capabilities, role)`.

**Calls / depends on.** `zod`, `./permissionMode` (`PermissionMode`, type-only), `./enums` (`reportStatusSchema`, `roleSchema`, `Capability`), `./question` (`evidenceRefSchema`), `./ids` (`repoPathSchema`, `timestampSchema`).

**Called from / used by.** Main only, extensively — this is the contract every runtime adapter implements and the orchestrator drives against.

---

### `src/shared/domain/task.ts`

**Purpose.** The `Task` entity — what to achieve and how completion will be judged, plus the `ScopePolicy` and `CompletionCriterion` sub-shapes.

**What it does.**
- `completionCriterionSchema`/`CompletionCriterion` — `kind`, `description`, `params` (loose `Record<string, unknown>`).
- `scopePolicySchema`/`ScopePolicy` — `allowedPaths`, `forbiddenPaths` (globs). Empty `allowedPaths` = "anywhere not forbidden."
- `taskSchema`/`Task` — `id`, `objective`, `constraints`, `completionCriteria` (**`.min(1)`**), `scope`, `lockedDecisionIds`, `correctsTaskId` (nullable), `createdAt`.

**Calls / depends on.** `zod`, `./enums` (`criterionKindSchema`), `./ids` (`decisionIdSchema`, `taskIdSchema`, `timestampSchema`).

**Called from / used by.** Main only: `src/main/workflows/workflowService.ts`.

---

### `src/shared/domain/template.ts`

**Purpose.** Workflow templates as data — named sequences of role-steps (`planner → user-approval → implementer → system-verify → reviewer`), where a template names **roles**, never runtimes.

**What it does.**
- `templateStepSchema`/`TemplateStep` — `role`, `label`, `advanceTrigger` (a `WorkflowTrigger`), `performedByForge`.
- `workflowTemplateSchema`/`WorkflowTemplate` — `id`, `name`, `description`, `steps` (`.min(1)`).
- Five built-in templates, all with the identical 5-step shape but different labels/descriptions: `FEATURE_IMPLEMENTATION` (`feature`), `BUG_FIX` (`bugfix`), `REFACTOR` (`refactor`), `SECURITY_AUDIT` (`security`), `TEST_COVERAGE` (`test-coverage`).
- `TEMPLATES` — `Record<TemplateId, WorkflowTemplate>`. `TemplateId = keyof typeof TEMPLATES`.
- `TemplateProblem` — `{stepIndex, detail}`.
- `validateTemplate(template)` — checks non-empty id/name, at least one step, `performedByForge` matches role exactly, non-empty labels.
- `exportTemplateJson(template)` / `importTemplateJson(jsonText)` — round-trip serialization with re-validation.
- `isTemplateId(value)` — `hasOwnProperty` check against `TEMPLATES` — **this is the function added this session (before the current session began, per prior context) to fix the hardcoded-template bug in `workflowService.ts`; confirm during refactor that it's present and wired, since earlier diagnosis found `HEAD` briefly unbuildable without it.**

**Calls / depends on.** `zod`, `./enums` (`roleSchema`), `./transitions` (`workflowTriggerSchema`).

**Called from / used by.** Main only: `src/main/ipc/handlers.ts`, `src/main/runtimes/orchestrator.ts`, `src/main/workflows/workflowService.ts`.

---

### `src/shared/domain/transitions.ts`

**Purpose.** The workflow state machine, expressed as **data** (a transition table) rather than scattered `if` chains — the authoritative definition of which state changes are legal.

**What it does.**
- `WORKFLOW_TRIGGERS` — `start, planProduced, userApproved, implementationStarted, implemented, verified, verificationFailed, reviewPassed, reviewFailed, correctionStarted, questionRaised, questionAnswered, limitReached, policyViolated, cancelled`.
- `DIRECTED_TRANSITIONS` — the per-state legal-move table (`DISCOVERY→PLANNING→PLAN_READY→DECISIONS_LOCKED→IMPLEMENTING→VERIFYING→{REVIEWING|CORRECTION_REQUIRED}→...→DONE`, with `CORRECTION_REQUIRED→IMPLEMENTING` looping back).
- `UNIVERSAL_TRANSITIONS` — triggers legal from any non-terminal state: `questionRaised→AWAITING_USER`, `limitReached→HALTED_LIMIT`, `policyViolated→HALTED_POLICY`, `cancelled→CANCELLED`.
- `TRANSITIONS` — flattened array of every legal `{from, trigger, to}`.
- `IllegalTransitionError` — names the attempted trigger and every trigger that would have been legal.
- `legalTriggers(from)` / `canTransition(from, trigger)`.
- `transition(from, trigger, context)` — applies a trigger or throws. Special cases: `questionAnswered` (requires `resumeState`), `questionRaised` (records `resumeState`), `correctionStarted` (increments `iteration`; **redirects to `HALTED_LIMIT` if it exceeds `maxIterations`** — the iteration cap is enforced inside this function itself).
- `renderStateDiagram()` — generates a Mermaid diagram, compared against the committed `docs/DOMAIN.md` by a test.
- `parseWorkflowState(value)`.

**Calls / depends on.** `zod`, `./enums` (`isTerminalWorkflowState`, `WORKFLOW_STATES`, `workflowStateSchema`, `WorkflowState`).

**Called from / used by.** Main only: `src/main/db/workflowStore.ts`, `src/main/evidence/verifier.ts`, `src/main/runtimes/orchestrator.ts`. Also depended on by `template.ts`.

---

### `src/shared/domain/workflow.ts`

**Purpose.** The `Workflow`, `WorkflowStep`, `WorkflowCheckpoint`, and `WorkflowLimits` entities — the persisted shape of a running workflow instance.

**What it does.**
- `workflowLimitsSchema`/`WorkflowLimits` — `maxIterations` (default 5), `stepTimeoutMs` (30min), `idleTimeoutMs` (10min), `totalTimeoutMs` (4hr), `maxRetries` (3), `retryDelayMs` (5s). Nested `stopOn`: `buildFailure`/`testFailure`/`openQuestion` (default false), `permissionViolation` (**typed as `z.literal(true)`**, not `boolean`), `unexpectedFileModification` (default true). Uses `.prefault({})` rather than `.default({})` — a measured zod 4 gotcha where `.default()` skips the schema entirely and previously silently disabled `unexpectedFileModification`.
- `workflowStepSchema`/`WorkflowStep` — `id`, `index`, `role`, `runtimeId` (nullable), `state`, `contextRef` (snapshot pointer, not embedded packet), `reportStatus`/`verdict`/`changeSetId` (nullable), `startedAt`/`finishedAt`.
- `workflowCheckpointSchema`/`WorkflowCheckpoint` — `stepIndex`, `state`, `startedAt`, `lastOperation`, `inputRef` (nullable — write-ahead, **#28**).
- `workflowSchema`/`Workflow` — `id`, `taskId`, `templateId`, `state`, `iteration` (counts review cycles, not steps), `limits`, `steps`, `checkpoint`, `resumeState`, `blockedByQuestionId`, `haltReason`, `startedAt`, `finishedAt`.
- `.check()` invariants: `AWAITING_USER` requires `resumeState`; non-`AWAITING_USER` requires `blockedByQuestionId === null`; a halted state requires `haltReason`; `iteration` cannot exceed `limits.maxIterations`.

**Calls / depends on.** `zod`, `./enums`, `./ids`.

**Called from / used by.** Main only: `src/main/db/projections.ts`, `src/main/db/schema.ts`, `src/main/db/workflowStore.ts`, `src/main/runtimes/orchestrator.ts`. Also depended on by `guards.ts` and `limitRules.ts`.

---

## Cross-cutting observations for the refactor

1. **Everything in `src/shared/domain` flows into `src/main` only**, via the single barrel `src/shared/domain/index.ts`. Zero renderer files import `@shared/domain` directly — the renderer consumes only `src/shared/ipc.ts`'s wire/view schemas, which are **structurally similar to but deliberately redeclared separately from** the domain types. Any refactor that merges or renames domain types must remember the wire schemas in `ipc.ts` are a parallel, independently-maintained set of shapes, not derived types.
2. **`src/shared/domain/limitRules.ts` has no consumers anywhere** outside its own test file, despite being fully implemented and exported from the barrel. A designed-but-never-wired feature.
3. **`src/shared/app.ts`'s `AppInfo`/`APP_NAME`** appear superseded by `src/shared/ipc.ts`'s own richer `appInfoSchema`/`AppInfo`.
4. **Determinism is a recurring, explicit invariant** across `contextEngine.ts`, `policy.ts`, `reconcile.ts`, and `guards.ts` — codepoint comparison over `localeCompare` everywhere, because prompt packets and event payloads are snapshotted and diffed across machines/CI runs.
5. **The "claim vs. fact" distinction (axiom A3)** is the single most repeated theme: `evidence.ts`, `changeset.ts`, `reconcile.ts`, `completion.ts`, `review.ts`, `protocol.ts`, and `runtime.ts` all separately encode some version of "what the agent said" vs. "what Forge measured."
6. **Axiom A4 (locked decisions are binding)** is enforced at the schema level in `decision.ts`; the file's own comment notes the command layer (`#40`, in `src/main`) is meant to enforce the same rule operationally — worth verifying agreement during refactor.
7. **Axiom A7 (least privilege) has three independent enforcement points** — `permissionsSchema` (project.ts), `policyEngine.ts`, and `guards.ts`'s `checkStopConditions` — plus the `z.literal(true)` typing trick in `workflow.ts`. Consistent today; a refactor touching any one should check the other two.
8. **`protocol.ts`'s `renderPromptPacket()`** is the exact function whose rendered output was found this session to be truncated in transit by the hosted Claude runtime's undermarked-paste bug — the render logic itself was correct; the fix belongs (and landed) in `interactiveTurn.ts`, not here. Worth keeping this function and its section-ordering logic stable, since `docs/CLI-FIELD-GUIDE.md` §9 documents exact measured behavior against its current output shape.
9. **`review.ts`'s `assessReview()`** is a fully real, carefully-designed override engine — but as of this session, `workflowService.ts` calls it with a **hardcoded stub claim** (`claimedVerdict: 'pass'`, no findings) rather than a real reviewer agent's output. The domain logic is not the gap; the wiring is.
# Forge — Handoff Document, Part 5: `src/renderer/` (React UI)

The renderer is a sandboxed React 18 SPA (no direct Electron/Node access). It talks to the main process exclusively through `window.forge` — an object injected by the preload bridge (typed in `forge.d.ts` from `src/preload/api.ts`). All pages use `HashRouter` (required because the packaged app loads via `file://`). State is split between a global "domain cache" (`projectStore`) and pure UI/layout state (`uiStore`); nearly every other piece of state (chat threads, custom agents, LLM provider configs, CLI agent configs, MCP servers, workflow templates) is persisted directly to `localStorage` rather than going through IPC — this is a notable architectural inconsistency worth flagging for the refactor (these look like mocked/local-only features bolted on ahead of real backend support).

---

## App shell / routing

### `src/renderer/src/App.tsx`
**Purpose:** Root component; builds the `HashRouter` route tree and wraps it in `ToastProvider`.
**What it does:** Exports `App()`. Builds `createHashRouter` from the `ROUTES` table (`app/routes.tsx`), mapping each route's `path` to its page element inside `<Shell />` as parent layout, plus a catch-all `NotFound`. Hash routing is deliberate: a packaged `file://` app has no server to resolve browser-history paths against.
**Calls / depends on:** `app/NotFound`, `app/Overview`, `app/routes` (`ROUTES`), `app/Settings`, `app/Shell`, `ui` (`ToastProvider`), `app/workflow/WorkflowPage`, `app/QuestionsPage`, `app/DecisionsPage`, `app/ChangesPage`, `app/AgentsPage`, `app/AskPage`. No direct IPC calls.
**Called from:** `main.tsx` (mounts `<App />`).

### `src/renderer/src/main.tsx`
**Purpose:** Renderer entry point.
**What it does:** Grabs `#root`, throws if missing, mounts `<App />` inside `<StrictMode>`, imports global `styles.css`.
**Calls / depends on:** `App.tsx`, `styles.css`.
**Called from:** Loaded by Vite/Electron as the renderer HTML's script entry.

### `src/renderer/src/forge.d.ts`
**Purpose:** Ambient type declaration exposing `window.forge: ForgeApi` (from `../preload/api`) globally.
**What it does:** No runtime code — pure TypeScript augmentation of the `Window` interface. This is the renderer's *only* declared route to `main`.
**Calls / depends on:** `../preload/api` (type only).
**Called from:** Implicitly included by TS compilation; every file calling `window.forge.*` relies on it.

### `src/renderer/src/ipc.ts`
**Purpose:** Thin helper for unwrapping the `IpcResult<T>` envelope every preload call returns.
**What it does:** Defines `ForgeIpcError` (carries `code` + `message`) and `unwrap<T>(result)` which throws `ForgeIpcError` on `{ ok: false }` or returns `.value` on success. Built on the renderer side deliberately — the comment explains the Electron context bridge strips prototypes/own-properties crossing the bridge, so constructing the error object here (not in preload) keeps `.code` intact and gives a useful stack trace.
**Calls / depends on:** `@shared/ipc` types (`IpcErrorCode`, `IpcResult`).
**Called from:** Nearly every page/component that calls `window.forge.*` (`unwrap(...)` wraps almost all IPC calls throughout the renderer).

### `src/renderer/src/app/routes.tsx`
**Purpose:** Single source of truth for navigation — route paths, labels, icons, and empty-state copy.
**What it does:** Exports `ROUTES` (`as const satisfies readonly RouteDefinition[]`) — an array of 8 routes (`/`, `/ask`, `/workflows`, `/decisions`, `/changes`, `/questions`, `/agents`, `/settings`), each with `label`, `icon` (JSX), and `empty: {title, description}`. Also exports derived types `RoutePath` and `Route`. Both `Sidebar` and `App`'s router build off this array so nav items and routes can't drift apart.
**Calls / depends on:** `./icons` (all icon components).
**Called from:** `App.tsx` (router construction), `Sidebar.tsx` (nav items), `Overview.tsx` (`ROUTES[0]` for label).

### `src/renderer/src/app/Shell.tsx`
**Purpose:** The application frame — top status strip + sidebar + routed `<Outlet/>` + centralizes modal state (Settings dialog, Create Project dialog, dev Kitchen Sink).
**What it does:** Exports `Shell()`. Wires `useUiStore` (settings/create-project dialog open state, sidebar collapse) and `useProjectStore` (`projects`, `selectedProjectId`, `select`, `refresh`). On mount calls `refresh()` once. Registers a global `Cmd/Ctrl+,` keydown handler to toggle Settings. Polls the active workflow's state via `window.forge.workflow.getActive(projectId)` and subscribes to `window.forge.onWorkflowEvent` to update a small `activeWorkflowState` used for `StatusStrip`'s status pill (`idle|running|waiting|passed|failed`). Lazily imports `dev/KitchenSink` only in `import.meta.env.DEV` builds, rendered inside a `Dialog`.
**Calls / depends on:** `ui` (`Dialog`), `./CreateProjectDialog`, `./projectStore`, `./Settings` (`SettingsDialog`), `./Sidebar`, `./StatusStrip` (+ `WorkflowStatePlaceholder` type), `./uiStore`, `../dev/KitchenSink` (lazy, dev-only). IPC: `window.forge.workflow.getActive`, `window.forge.onWorkflowEvent`.
**Called from:** `App.tsx` (root layout element for all routes).

### `src/renderer/src/app/Sidebar.tsx`
**Purpose:** Persistent left navigation (collapsible), including an unanswered-questions badge and a Settings entry.
**What it does:** Exports `Sidebar()`. Reads `ROUTES`, splits into `primaryRoutes` (all but `/settings`) and `settingsRoute` (rendered separately as a button that opens the Settings modal rather than routing). Computes `unansweredCount`: if a project is selected, calls `window.forge.question.list(projectId, true)`; otherwise sums unanswered across all projects. Refreshes on `window.forge.onWorkflowEvent`. Renders `NavItem` (uses `NavLink`) with an animated pulsing `Badge` for unanswered question count; collapsed mode shows a small dot badge instead of the number.
**Calls / depends on:** `../ipc` (`unwrap`), `../ui` (`Badge`, `IconButton`, `Separator`, `Tooltip`, `cn`), `./icons` (`CollapseIcon`, `ExpandIcon`), `./projectStore`, `./routes`, `./uiStore`. IPC: `window.forge.question.list`, `window.forge.onWorkflowEvent`.
**Called from:** `Shell.tsx`.

### `src/renderer/src/app/StatusStrip.tsx`
**Purpose:** The always-visible frameless title bar: branding, window drag region, project switcher, "New" project button, pre-alpha badge, dev-only Kitchen Sink button.
**What it does:** Exports `StatusStrip` (props-driven, no internal IPC) and the `WorkflowStatePlaceholder` type (`'idle'|'running'|'waiting'|'passed'|'failed'`, re-exported by `Shell`). Renders a `Select` for active project (built from `projects` prop) and buttons wired to callbacks passed in. `workflowState` prop is currently accepted but not visibly rendered in this component body (destructured out but unused in JSX) — worth checking during refactor.
**Calls / depends on:** `@shared/ipc` (`ProjectView` type), `../ui` (`Badge`, `Button`, `Select`, `Separator`). No direct IPC.
**Called from:** `Shell.tsx`.

### `src/renderer/src/app/NotFound.tsx`
**Purpose:** Catch-all `*` route — should be unreachable since nav is generated from `ROUTES`.
**What it does:** Exports `NotFound()`. Shows an `EmptyState` with the offending hash/path and a "Back to overview" button using `useNavigate`.
**Calls / depends on:** `react-router` (`useNavigate`), `../ui` (`Button`, `Code`, `EmptyState`). No IPC.
**Called from:** `App.tsx` router (`path: '*'`).

### `src/renderer/src/app/icons.tsx`
**Purpose:** Hand-drawn 16px-grid SVG icon set for navigation (avoids pulling in an icon package for ~10 glyphs).
**What it does:** Exports `OverviewIcon`, `WorkflowsIcon`, `TasksIcon` (unused — no route uses "Tasks"), `DecisionsIcon`, `ChangesIcon`, `QuestionsIcon`, `AgentsIcon`, `SettingsIcon`, `CollapseIcon`, `ExpandIcon`, `AskIcon`, `CloseIcon`. All wrap a shared internal `Icon` helper (`aria-hidden`).
**Calls / depends on:** None (self-contained SVG).
**Called from:** `routes.tsx` (per-route icon), `Sidebar.tsx` (`CollapseIcon`/`ExpandIcon`), `Settings.tsx` (`CloseIcon`), `ChangesPage.tsx`/`DecisionsPage.tsx`/`QuestionsPage.tsx` (their respective icons). `TasksIcon` appears unused anywhere — dead export.

### `src/renderer/src/app/projectStore.ts`
**Purpose:** Zustand store — the renderer's cache of project data as reported by main; explicitly *not* a second source of truth.
**What it does:** Exports `useProjectStore` (persisted via `zustand/middleware persist`, key `forge.projects`, but `partialize` keeps **only** `selectedProjectId` — a pointer, never the fetched rows). State: `projects`, `selectedProjectId`, `detail` (`ProjectDetail | null`), `loading`, `error`. Actions: `refresh()` (re-fetches `project.list()`, validates the remembered `selectedProjectId` still exists among returned rows, falls back to first project, then fetches `project.get(id)` for `detail`), `select(projectId)`, `createProject(request)` (creates via IPC then calls `refresh()` — never merges the create-response directly into state), `applyRule(scope, key, statement)`, `removeRule(ruleId)`, `deleteProject(projectId)`.
**Calls / depends on:** `zustand`, `zustand/middleware`, `@shared/ipc` types, `../ipc` (`unwrap`). IPC: `window.forge.project.list/get/create/update/delete`, `window.forge.rule.set/remove`.
**Called from:** Nearly every page and dialog (`Shell`, `Sidebar`, `Overview`, `AskPage`, `AgentsPage`, `ChangesPage`, `DecisionsPage`, `QuestionsPage`, `Settings`, `CreateProjectDialog`, `EditProjectDialog`, `DeleteProjectDialog`, `WorkflowPage`) — the central domain-state hub of the whole app.

### `src/renderer/src/app/uiStore.ts`
**Purpose:** Zustand store for pure UI/layout preferences — explicitly documented as never allowed to hold domain data, to keep "Forge owns the truth, renderer is a view of it" intact.
**What it does:** Exports `useUiStore` (persisted, key `forge.ui`, `partialize` keeps only `sidebarCollapsed`). State/actions: `sidebarCollapsed` + toggles; `settingsOpen` + open/close/toggle; `createProjectOpen` + open/close.
**Calls / depends on:** `zustand`, `zustand/middleware`. No IPC.
**Called from:** `Shell.tsx`, `Sidebar.tsx`, `Overview.tsx`, `Settings.tsx`.

---

## Pages

### `src/renderer/src/app/Overview.tsx`
**Purpose:** Landing page — shows the bound repository's live git state, project rules, and a welcome/onboarding screen when no project exists.
**What it does:** Exports `Overview()`. Reads `detail`/`loading`/`error` from `projectStore`. Three states: error badge, loading spinner, `WelcomeWorkspace` (no project — CTA to open `CreateProjectDialog`, feature highlight cards, embedded `RuntimeCard`), or `ProjectSummary` (repository path/branch/head/dirty-count, build/test commands, tech tags, rules list, "Edit settings" opening `EditProjectDialog`). `RuntimeCard` calls `window.forge.app.getInfo()` once on mount to show Electron/Node/Chromium versions as a connectivity smoke-test.
**Calls / depends on:** `@shared/ipc` types, `../ipc` (`unwrap`), `../ui` (`Badge, Button, Card*, Code, ScrollArea, Separator, Spinner, StatusDot`), `./EditProjectDialog`, `./projectStore`, `./routes` (`ROUTES[0]`), `./uiStore`. IPC: `window.forge.app.getInfo`.
**Called from:** `App.tsx` router (index route `/`).

### `src/renderer/src/app/AskPage.tsx`
**Purpose:** A ChatGPT-style "ask the codebase" chat UI with personas, providers/models, and multiple threads.
**What it does:** Exports `AskPage()`. Almost entirely `localStorage`-backed rather than IPC/DB-backed: custom agents (`forge.custom_agents`), provider configs (`forge.providers`), active provider id, chat threads (`forge.ask_threads`) are all read/written directly to `localStorage`. Real IPC calls: `window.forge.provider.scanModels('ollama', ...)` on mount to auto-detect local Ollama models; `window.forge.binding.list(project.id)` to populate the "engine" selector with real bound runtimes; `window.forge.provider.chat({...})` to actually send the conversation (system prompt built from project name/branch/head/tech/rules + persona description) and get a completion. Renders a two-pane layout: left sidebar (new-chat button, search, sort toggle, thread list, persona `Select`), right main pane (message list, model/engine selectors, message input form). Builtin personas: planner/coder/reviewer/tester/qa/debugger, extended with any custom agents from storage.
**Calls / depends on:** `../ui` (`Badge, Button, CustomAgentConfig, Input, MarkdownRenderer, ScrollArea, Select, useToast, cn`), `./projectStore`, `@renderer/ipc` (`unwrap`). IPC: `window.forge.provider.scanModels`, `window.forge.binding.list`, `window.forge.provider.chat`.
**Called from:** `App.tsx` router (`/ask`).

### `src/renderer/src/app/AgentsPage.tsx`
**Purpose:** Configure per-project role→runtime bindings (planner/implementer/reviewer) and manage a roster of custom agent personas.
**What it does:** Exports `AgentsPage()`. Loads `RoleBindingsView` via `window.forge.binding.list(projectId)`; `handleBind(role, runtimeId)` calls `window.forge.binding.set` then reloads. Custom agents (again `localStorage`-backed, `forge.custom_agents`, seeded from `DEFAULT_BUILTIN_AGENTS`) rendered as `AgentCard`s; each shows whether it's "assigned" by cross-referencing the *actual* stored binding for its `roleType` (deliberately not falling back to the agent's own stored `runtimeId`, per an inline comment fixing a bug where an unbound role showed a stale/misleading "Bound" label). `CreateAgentDialog` lets the user add a new custom persona.
**Calls / depends on:** `@shared/ipc` (`RoleBindingsView`), `@renderer/ui` (`AgentCard, Badge, Button, Card, CreateAgentDialog, CustomAgentConfig, EmptyState, Select, useToast`), `@renderer/ipc` (`unwrap`), `./projectStore`. IPC: `window.forge.binding.list`, `window.forge.binding.set`.
**Called from:** `App.tsx` router (`/agents`).

### `src/renderer/src/app/ChangesPage.tsx`
**Purpose:** Inspect repository diffs — either a specific recorded `ChangeSet` (from a workflow step) or the live working-tree diff — plus a secondary "Explorer" mode to browse the whole file tree for context.
**What it does:** Exports `ChangesPage()`. Loads three things per active project: `window.forge.changeset.list(projectId)`, `window.forge.git.getWorkingDiff(projectId)`, `window.forge.git.listFiles(projectId)`. Refetches on `window.forge.onWorkflowEvent`. Source selector switches between "Working Tree" and individual changesets (shows review verdict/discrepancy badges). Two tabs: "Changes" (flat `FileTree`) vs "Explorer" (hierarchical `FileTree` over `allFiles`). Selected file content fetched via `window.forge.git.readFile`; `extractFilePatch` slices the per-file hunk out of the full unified patch. `handleSaveFile` calls `window.forge.git.writeFile` — but the save affordance (`onSaveFile` prop on `CodeViewer`) is only passed in "changes" view, not "explorer" view, by deliberate design.
**Calls / depends on:** `@shared/ipc` types, `../ipc` (`unwrap`), `../ui` (`Badge, Button, CodeViewer, EmptyState, FileTree, useToast`), `./icons` (`ChangesIcon`), `./projectStore`. IPC: `window.forge.changeset.list`, `window.forge.git.getWorkingDiff/listFiles/readFile/writeFile`, `window.forge.onWorkflowEvent`.
**Called from:** `App.tsx` router (`/changes`).

### `src/renderer/src/app/DecisionsPage.tsx`
**Purpose:** List/manage architectural decisions (propose, approve, lock, supersede) — the enforcement surface for "locked decisions bind future agent behavior."
**What it does:** Exports `DecisionsPage()`. Loads decisions for the selected project (or aggregates across all projects if none selected) via `window.forge.decision.list`. Tabs: all/locked/proposed/superseded. Actions call `window.forge.decision.approve/lock/supersede/propose`, each showing a toast and bumping a `reloadTrigger` to refetch; also refetches on `window.forge.onWorkflowEvent`. Includes a "Propose Decision" `Dialog` with statement/rationale fields.
**Calls / depends on:** `@shared/ipc` (`DecisionView`), `../ipc` (`unwrap`), `../ui` (`Button, DecisionCard, Dialog, EmptyState, Field, Input, ScrollArea, Tabs, Textarea, useToast`), `./icons` (`DecisionsIcon`), `./projectStore`. IPC: `window.forge.decision.list/approve/lock/supersede/propose`, `window.forge.onWorkflowEvent`.
**Called from:** `App.tsx` router (`/decisions`).

### `src/renderer/src/app/QuestionsPage.tsx`
**Purpose:** List/answer open questions raised by agents that block a running workflow.
**What it does:** Exports `QuestionsPage()`. Loads questions per selected project (or aggregated across all) via `window.forge.question.list`. Tabs: unanswered/all, with a pulsing warning banner when there are unanswered questions. `handleAnswer(questionId, answerText, lockDecision)` calls `window.forge.question.answer`, resuming the paused workflow; each `QuestionCard`'s "View Workflow" button navigates to `/workflows`. Refetches on `window.forge.onWorkflowEvent`. Distinguishes "no questions have ever been asked" from "all questions have been answered" in the empty-state copy (issue #108 fix).
**Calls / depends on:** `@shared/ipc` (`OpenQuestionView`), `../ipc` (`unwrap`), `../ui` (`EmptyState, QuestionCard, ScrollArea, Tabs, useToast`), `./icons` (`QuestionsIcon`), `./projectStore`, `react-router` (`useNavigate`). IPC: `window.forge.question.list/answer`, `window.forge.onWorkflowEvent`.
**Called from:** `App.tsx` router (`/questions`).

### `src/renderer/src/app/Settings.tsx`
**Purpose:** The largest single file in the renderer (~2264 lines). Combines global app settings (general/appearance, CLI agents, LLM providers, MCP/customizations) and per-project settings (repository details, rules, danger zone) in one two-level nav layout. Also exports the modal wrapper `SettingsDialog` used from `Shell`.
**What it does:** Exports `Settings()` (thin wrapper rendering `SettingsContent`) and `SettingsContent()` (the actual page). `SettingsDialog({open, onClose})` renders a full-screen backdrop modal hosting `SettingsContent`.
  - **Global tabs:** `GeneralGlobalSettings` (global instruction text persisted to `forge.global_instructions`; theme via `useTheme`; motion preference `forge.motion`; sidebar default via `uiStore`; notification toggles; toast duration local state; "Execution Sandboxing" section — worktree isolation mode, decision-lock requirement, prune-worktrees toggle — all **local component state, not persisted anywhere and not wired to any IPC/backend**, i.e. cosmetic-only controls currently; File/Terminal boundary rules shown in a read-only info `Dialog`).
  - `CliAgentsGlobalSettings`: manages `CliAgentConfig[]` in `localStorage` (`forge.cli_agents`), seeded from `DEFAULT_CLI_AGENTS`. "Verify Status" is a `setTimeout`-simulated check, not a real IPC probe. Includes `AddCliAgentDialog`.
  - `AIProvidersSettings`: manages `StoredProviderConfig[]` in `localStorage` (`forge.providers`) seeded from `DEFAULT_PROVIDERS` (OpenAI, Messages API, Google AI, DeepSeek, OpenRouter, Mistral, Ollama, LM Studio). Auto-scans Ollama on mount via `window.forge.provider.scanModels`. `AddProviderDialog` adds custom providers.
  - `CustomizationsGlobalSettings`: manages `McpServerConfig[]` in `localStorage` (`forge.mcp_servers`) seeded from `DEFAULT_MCP_SERVERS`. "Ping" test is `setTimeout`-simulated.
  - `ProjectLevelSettings`: repository detail readout, rules CRUD, "Edit Repository" and "Remove Project" danger-zone actions.
**Calls / depends on:** `@shared/ipc` types, `../ui` (`AddCliAgentDialog, AddMcpServerDialog, AddProviderDialog, Badge, Button, Card, CliAgentConfig, CustomProviderConfig, Dialog, EmptyState, IconButton, Input, McpServerConfig, ProviderCard, ScrollArea, Select, Separator, Spinner, StatusDot, Textarea, useTheme, useToast`), `./DeleteProjectDialog`, `./EditProjectDialog`, `./icons` (`CloseIcon`), `./projectStore`, `./uiStore`. IPC: `window.forge.provider.scanModels`.
**Called from:** `App.tsx` router (`/settings`), `Shell.tsx` (`SettingsDialog`).

### `src/renderer/src/app/CreateProjectDialog.tsx`
**Purpose:** New-project creation flow — bind a local git repository to Forge.
**What it does:** Outer `CreateProjectDialog` remounts `CreateProjectForm` with a `key={generation}` bump on close, so form state is fresh each time it's opened. `CreateProjectForm`: debounced (300ms) repository probing via `window.forge.project.probeRepository(path)`; distinguishes *blocking* problems from non-blocking warnings; auto-suggests the project name from the folder basename once resolved. "Browse…" calls `window.forge.dialog.pickDirectory()`. On submit calls `projectStore.createProject(...)`.
**Calls / depends on:** `@shared/ipc` (`RepositoryProbe`), `../ipc` (`unwrap`), `../ui` (`Badge, Button, Code, Dialog, Field, Input, Spinner, StatusDot, Textarea, useToast`), `./projectStore`. IPC: `window.forge.project.probeRepository`, `window.forge.dialog.pickDirectory`.
**Called from:** `Shell.tsx`.

### `src/renderer/src/app/EditProjectDialog.tsx`
**Purpose:** Edit an existing project's settings (name, default branch, build/test commands, tech tags) — repository path itself is immutable by design.
**What it does:** Seeded from props on mount only (remounted via `key` by the caller, deliberately not synced via effect). Uses inline `Select`/`Input` logic for default branch with a hint showing when the stored default branch disagrees with what git itself reports. Saves via `window.forge.project.update(...)`. Embeds a "Remove Project…" button opening `DeleteProjectDialog`.
**Calls / depends on:** `@shared/ipc` (`ProjectView`, `RepositoryProbe`), `@renderer/ui` (`Button, Code, Dialog, Field, Input, Select, useToast`), `@renderer/ipc` (`unwrap`), `./DeleteProjectDialog`. IPC: `window.forge.project.update`.
**Called from:** `Overview.tsx`, `Settings.tsx`.

### `src/renderer/src/app/DeleteProjectDialog.tsx`
**Purpose:** Confirm+execute project removal from Forge's own session/DB records — explicitly does **not** touch files on disk or the git repository.
**What it does:** Calls `projectStore.deleteProject(projectId)`, shows success/error toast, calls optional `onDeleted` callback.
**Calls / depends on:** `@shared/ipc` (`ProjectView`), `@renderer/ui` (`Button, Code, Dialog, useToast`), `./projectStore`. IPC: indirectly `window.forge.project.delete` via the store.
**Called from:** `EditProjectDialog.tsx`, `Settings.tsx`.

### `src/renderer/src/app/DefaultBranchField.tsx`
**Purpose:** A shared "default branch" form field meant to present git's own authoritative answer (`origin/HEAD`) as a stated fact rather than a question.
**What it does:** Exports `DefaultBranchField({probe, value, onChange})`. Internal `overridden` toggle. If the source is `origin-head` and matches `value`, renders a read-only "fact" row with a "Change" button instead of an editable field; otherwise renders a `Select`/`Input` with a hint naming the source.
**Calls / depends on:** `@shared/ipc` (`RepositoryProbe`), `../ui` (`Button, Code, Field, Input, Select`). No IPC.
**Called from:** **Nowhere** — confirmed via grep, only its own test references it. `CreateProjectDialog.tsx` and `EditProjectDialog.tsx` each reimplement similar (but not identical) logic inline instead. **Dead/unused code.**

### `src/renderer/src/app/AccountEnrollment.tsx`
**Purpose:** Per-account sign-in status/control for a CLI runtime — designed so Forge never handles credentials directly.
**What it does:** Exports `AccountEnrollment({accountId, runtimeId})`. Calls `window.forge.account.enrollmentStatus`/`beginEnrollment`. Distinguishes "not signed in" from "this runtime cannot isolate multiple accounts."
**Calls / depends on:** `@renderer/ui` (`Badge, Button, useToast`), `@renderer/ipc` (`unwrap`). IPC: `window.forge.account.enrollmentStatus`, `window.forge.account.beginEnrollment`.
**Called from:** **Nowhere.** Fully wired to real IPC but never mounted anywhere in the app. **Dead/unused code.**

---

## Workflow view

### `src/renderer/src/app/workflow/WorkflowPage.tsx`
**Purpose:** The primary "run and watch a workflow" screen — pipeline graph, live agent terminal, step inspector, launchpad for starting new work.
**What it does:** Exports `WorkflowPage()`. Loads the active workflow (`window.forge.workflow.getActive`), polls every 1500ms for state changes, subscribes to `window.forge.onWorkflowEvent`/`onWorkflowLog`. Loads templates via `window.forge.template.list()` merged with `localStorage`-backed custom templates. Loads role bindings via `window.forge.binding.list`. `handleStartWorkflow` → `window.forge.workflow.start`. `handleApproveAndImplement` — first checks whether any decision is already `locked`/`approved`, and if not, **auto-proposes, approves, and locks a synthetic decision** purely to satisfy the "at least one locked decision" precondition, before calling `window.forge.workflow.approveAndStartImplementation`. `handleCancelWorkflow` → `window.forge.workflow.cancel`. `handleExportReport` → `window.forge.workflow.saveReport`. Builds `stageSteps` by merging the active template's step list with the real `workflow.steps`, synthesizing placeholder "pending" steps for stages not yet started. Renders an inline pipeline graph (its own logic, not `WorkflowGraph.tsx`), an `AgentTerminal` bound to the currently-selected step, and a `StepInspector` panel. Has an explicit code comment explaining that `RealTerminal` was removed here because it "looked like transparency and conveyed nothing about the run" (issue #154) — confirms `RealTerminal` is a deliberately-abandoned decoy.
**Calls / depends on:** `@shared/ipc` types, `@renderer/ui` (`AgentTerminal, Badge, Button, Card, CreateTemplateDialog, MarkdownRenderer, StartWorkflowDialog, StatusDot, useToast, WorkflowEdge, WorkflowLaunchpad, WorkflowNode`), `@renderer/ipc` (`unwrap`), `../projectStore`, `./StepInspector`. IPC: `window.forge.workflow.getActive/get/getLogs/start/approveAndStartImplementation/cancel/saveReport`, `window.forge.template.list`, `window.forge.binding.list`, `window.forge.decision.list/propose/approve/lock`, `window.forge.onWorkflowEvent`, `window.forge.onWorkflowLog`.
**Called from:** `App.tsx` router (`/workflows`).

### `src/renderer/src/app/workflow/StepInspector.tsx`
**Purpose:** Right-side detail panel for a selected workflow step — three tabs: Summary, Instruction Sent (the actual prompt packet), Verdict & Evidence.
**What it does:** Exports `StepInspector({step, onClose})`. Fetches the step's `PromptPacketView` via `window.forge.workflow.getPacket(step.contextRef)`. A 4th tab ("Live Console & Output") was deliberately removed — it duplicated the terminal's own output at lower fidelity.
**Calls / depends on:** `@shared/ipc` (`PromptPacketView`, `WorkflowStepView`), `@renderer/ui` (`Badge, Button, MarkdownRenderer, Spinner, TabPanel, Tabs`), `@renderer/ipc` (`unwrap`). IPC: `window.forge.workflow.getPacket`.
**Called from:** `WorkflowPage.tsx`.

### `src/renderer/src/app/workflow/WorkflowGraph.tsx`
**Purpose:** (Originally) a standalone pipeline-graph component rendering fixed default stages mapped onto real workflow steps.
**What it does:** Exports `WorkflowGraph({workflow, selectedStepId, onSelectStep})`.
**Calls / depends on:** `@shared/ipc` types, `@renderer/ui` (`WorkflowEdge, WorkflowNode, WorkflowNodeState`). No IPC.
**Called from:** **Nowhere** — `WorkflowPage.tsx` builds an equivalent graph inline instead. **Dead/unused component.**

### `src/renderer/src/app/workflow/LiveLogViewer.tsx`
**Purpose:** (Originally) a standalone live-log panel with search, pause/freeze, auto-scroll, copy-to-clipboard.
**What it does:** Exports `LiveLogViewer({logs, onClear})`.
**Calls / depends on:** `@renderer/ui` (`Button, Input`). IPC: `window.forge.clipboard.writeText`.
**Called from:** **Nowhere** — superseded by `AgentTerminal` inside `WorkflowPage`. **Dead/unused component.**

### `src/renderer/src/app/workflow/WorkflowPreflight.tsx`
**Purpose:** (Originally) a pre-workflow-start overview card surfacing blocking/non-blocking readiness warnings.
**What it does:** Exports `WorkflowPreflight({template, project, bindings, onlySimulated})`.
**Calls / depends on:** `@shared/ipc` types, `@renderer/ui` (`Badge`). No IPC.
**Called from:** **Nowhere outside its own test.** Superseded by `StartWorkflowDialog`/`WorkflowLaunchpad`. **Dead/unused component.**

---

## UI primitives — simple / presentational

### `src/renderer/src/ui/cn.ts`
**Purpose:** `cn(...)` class-name merge helper (clsx + tailwind-merge). **Called from:** Nearly every primitive and page.

### `src/renderer/src/ui/theme.ts`
**Purpose:** `useTheme()` hook — manages `'dark'|'light'|'azure'|'system'`, applied as `data-theme` on `<html>`, persisted to `localStorage` (`forge.theme`), tracks OS `prefers-color-scheme`. **Called from:** `Settings.tsx`, `dev/KitchenSink.tsx`, `RealTerminal.tsx`.

### `src/renderer/src/ui/index.ts`
**Purpose:** The single public import surface for the whole design system — pages must import primitives from here.
**What it does:** Re-exports every primitive and its prop types. Notably still exports `DiffViewer` and `RealTerminal` even though both are dead code with no consumers besides this index and their own tests — a refactor should prune both exports unless re-adoption is planned.

### `src/renderer/src/ui/primitives/Badge.tsx` — `cva`-based pill; tones neutral/accent/success/warning/danger/info. Used pervasively.
### `src/renderer/src/ui/primitives/Button.tsx` — variants primary/secondary/ghost/danger/danger-subtle; `loading` shows inline `Spinner`. Used everywhere.
### `src/renderer/src/ui/primitives/Card.tsx` — `Card`+`CardHeader/Title/Description/Content/Footer`; tones default/raised/inset. Used pervasively.
### `src/renderer/src/ui/primitives/Checkbox.tsx` — real `<input type="checkbox">`, `appearance-none` + inline SVG tick. Used in `AddCliAgentDialog`, `CreateAgentDialog`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Code.tsx` — `Code` (inline) and `CodeBlock` (block, optional line numbers). Used throughout.
### `src/renderer/src/ui/primitives/Dialog.tsx` — modal on native `<dialog>` (`showModal()`/`close()`), sizes sm/md/lg/xl. Base for nearly every modal in the app.
### `src/renderer/src/ui/primitives/Drawer.tsx` — side-panel variant of `Dialog`. Used only in `dev/KitchenSink` (demo) — not used by any real page currently.
### `src/renderer/src/ui/primitives/EmptyState.tsx` — icon+title+description+optional action. Used in `ChangesPage`, `DecisionsPage`, `QuestionsPage`, `AgentsPage`, `Settings`, `NotFound`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Field.tsx` — label+control+hint/error via render-prop `children(bind)`. Used across essentially every form dialog.
### `src/renderer/src/ui/primitives/IconButton.tsx` — icon-only button requiring a `label` prop. Used in `Sidebar`, `Dialog`, `Drawer`, `Toast`, `Settings`.
### `src/renderer/src/ui/primitives/Input.tsx` — `Input`+`Textarea`, `cva`-based. Used essentially everywhere.
### `src/renderer/src/ui/primitives/ScrollArea.tsx` — thin styled-scrollbar wrapper over native overflow (deliberately not virtualized). Used in `Overview`, `AskPage`, `DecisionsPage`, `QuestionsPage`, `Settings`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Select.tsx` — fully custom accessible dropdown (not native `<select>`) — floating popover, keyboard nav, `direction: up|down`. Used pervasively.
### `src/renderer/src/ui/primitives/Separator.tsx` — divider, `decorative` toggles ARIA role. Used in `Sidebar`, `StatusStrip`, `Overview`, `Settings`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Spinner.tsx` — `cva`-based spinning ring, `role="status"`. Used widely for loading states.
### `src/renderer/src/ui/primitives/StatusDot.tsx` — colored dot for workflow/agent status, optional `pulse`. Used in `Overview`, `WorkflowPage`, `WorkflowNode`, `QuestionCard`, `ProviderCard`, `Settings`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Tabs.tsx` — `Tabs`/`TabPanel`, ARIA tabs pattern, controlled. Used in `DecisionsPage`, `QuestionsPage`, `StepInspector`, `dev/KitchenSink`.
### `src/renderer/src/ui/primitives/Toast.tsx` — `ToastProvider`/`useToast` (context-based), auto-dismiss, `aria-live="polite"`. Used app-wide.
### `src/renderer/src/ui/primitives/Tooltip.tsx` — hover/focus tooltip (not touch-reachable). Used in `Sidebar` (collapsed labels), `dev/KitchenSink`.

---

## UI primitives — complex / stateful

### `src/renderer/src/ui/primitives/FileTree.tsx`
**Purpose:** File browser supporting both a flat "changed files only" list and a full hierarchical directory tree with search/filter, expand/collapse-all, per-file change badges, insertion/deletion counts.
**What it does:** Exports `FileTree` (dispatches to `FlatFileTree` or `HierarchicalFileTree`). `HierarchicalFileTree` maintains `userExpandedFolders`, auto-expands ancestors of the selected/search-matched path via `useMemo`.
**Calls / depends on:** `@shared/ipc` types, `./Badge`, `./FileIcons`, `./fileTreeModel`, `../cn`. No IPC.
**Called from:** `ChangesPage.tsx` (both tabs).

### `src/renderer/src/ui/primitives/fileTreeModel.ts`
**Purpose:** Pure data-transform logic backing `FileTree`.
**What it does:** `normalizePath`, `buildFileTree(filePaths, changedFiles, discrepancies)` (Map-based, then freezes+sorts — directories first, then alphabetical/numeric), `filterFileTree(nodes, query)`, `collectAllDirectoryPaths`, `getAncestorsOfPath`.
**Calls / depends on:** `@shared/ipc` types only. **Called from:** `FileTree.tsx`.

### `src/renderer/src/ui/primitives/FileIcons.tsx`
**Purpose:** File/folder icon resolution by extension. `FileIcon`, `FolderChevron`.
**Called from:** `FileTree.tsx`, `DiffViewer.tsx` (dead), `CodeViewer.tsx`.

### `src/renderer/src/ui/primitives/DiffViewer.tsx`
**Purpose:** Unified-diff viewer with optional inline edit-mode.
**What it does:** Exports `DiffViewer({filePath, patch, fileContent, discrepancies, isSaving, onSaveFile})`. Parses via `parseDiffLines`, renders header/hunk/add/del/context rows with syntax-highlighted tokens.
**Calls / depends on:** `@shared/ipc` (`DiscrepancyView`), `./Badge`, `./Button`, `./FileIcons`, `./Input` (`Textarea`), `./syntaxHighlighter`, `../cn`.
**Called from:** **Only `ui/index.ts` (export) and its own test.** `ChangesPage.tsx` uses `CodeViewer` instead. **Dead/unused component** — significant code duplication with `CodeViewer.tsx`'s diff-mode rendering.

### `src/renderer/src/ui/primitives/CodeViewer.tsx`
**Purpose:** The actual file-viewing/diffing component used by the app — code view, unified diff, split diff, inline edit mode, image-file placeholder, hunk navigation, word-wrap toggle, copy-path.
**What it does:** Exports `CodeViewer({filePath, content, patch, discrepancies, isSaving, onSaveFile, defaultMode})`. Detects image extensions and shows a placeholder. Uses `highlightCode`/`parseDiffLines`/`buildSplitDiff` from `syntaxHighlighter.ts`. `scrollToHunk` does DOM querying + `scrollIntoView`. `handleCopyPath` calls `window.forge.clipboard.writeText`.
**Calls / depends on:** `@shared/ipc` (`DiscrepancyView`), `./Badge`, `./Button`, `./FileIcons`, `./Input` (`Textarea`), `./syntaxHighlighter`, `../cn`. IPC: `window.forge.clipboard.writeText`.
**Called from:** `ChangesPage.tsx` (the sole real consumer).

### `src/renderer/src/ui/primitives/syntaxHighlighter.ts`
**Purpose:** Hand-rolled (no external library) tokenizer/highlighter and diff-parser shared by `CodeViewer`/`DiffViewer`.
**What it does:** `detectLanguage(filePath)`, `highlightLine`/`highlightCode` (per-language tokenizers for TS/JS, JSON, Python, Rust, SQL, Markdown, diff, generic), `parseDiffLines(patch, filePathOrLang)`, `buildSplitDiff(parsedLines)`.
**Called from:** `DiffViewer.tsx` (dead), `CodeViewer.tsx` (live).

### `src/renderer/src/ui/primitives/WorkflowNode.tsx`
**Purpose:** A single pipeline-stage card — role icon/persona name, live status dot, runtime engine + verdict badges.
**What it does:** Exports `WorkflowNode` (forwardRef button). Maps `WorkflowNodeState` to a `StatusDot` status. Resolves a friendly persona icon/name from `role` — this mapping is **duplicated in at least three places** (`WorkflowPage.getPersonaForRole`, `WorkflowGraph`'s `DEFAULT_STAGES`, and here) rather than centralized.
**Calls / depends on:** `../cn`, `./StatusDot`. **Called from:** `WorkflowPage.tsx`, `WorkflowGraph.tsx` (dead).

### `src/renderer/src/ui/primitives/WorkflowEdge.tsx`
**Purpose:** Connector between two `WorkflowNode`s — line + chevron, colored/animated by `state`. **Called from:** `WorkflowPage.tsx`, `WorkflowGraph.tsx` (dead).

### `src/renderer/src/ui/primitives/MarkdownRenderer.tsx`
**Purpose:** Hand-rolled minimal Markdown renderer (no external library) — headers, bullet/numbered lists, fenced code blocks with copy button, inline bold/code, paragraphs.
**Called from:** `AskPage.tsx`, `WorkflowPage.tsx`, `StepInspector.tsx`.

### `src/renderer/src/ui/primitives/AgentTerminal.tsx`
**Purpose:** The terminal actually used in the app today — a **read-only structured log feed** styled like a terminal, not a real PTY.
**What it does:** Exports `AgentTerminal({logs, title, personaName, runtimeId, repositoryPath, isRunning, onSendInput, onClear, className})`. Renders each `TerminalLogEntry` through `AnsiRenderer`, with heuristic color classing based on substring matches. Has an `onSendInput` prop + input bar, but the input bar only renders when `onSendInput !== undefined` — **and `WorkflowPage.tsx` never passes `onSendInput`**, so the input box never appears in practice; correctly gated off rather than shown-but-nonfunctional. No IPC calls of its own — receives `logs` as props.
**Calls / depends on:** `./AnsiRenderer`, `./Badge`, `./Button`. **Called from:** `WorkflowPage.tsx` (sole real consumer, `onSendInput` intentionally omitted).

### `src/renderer/src/ui/primitives/RealTerminal.tsx`
**Purpose:** A genuine interactive PTY-backed terminal using `@xterm/xterm` + `@xterm/addon-fit`, fully wired to real IPC (`window.forge.terminal.spawn/write/kill/resize`, `onTerminalData`, `onTerminalExit`) with theme-aware colors, resize observation, clear/restart controls.
**What it does:** Exports `RealTerminal({projectId, command, args, cwd, title, personaName, runtimeId, className, onExit})`. Fits the terminal synchronously before spawn (a deferred fit caused the PTY to be created at 80×24 and visibly wrap). Cleanup kills via `window.forge.terminal.kill`.
**Calls / depends on:** `@xterm/xterm`, `@xterm/addon-fit`, `@renderer/ipc` (`unwrap`), `../theme` (`useTheme`), `./Badge`, `./Button`. IPC: `window.forge.terminal.spawn/write/kill/resize`, `onTerminalData`, `onTerminalExit`.
**Called from:** **Nowhere in the current app** — only `ui/index.ts` (export) references it. `WorkflowPage.tsx` explicitly does *not* use it — it spawned a *second*, independent CLI session showing its own idle banner rather than the actual working agent's output ("it looked like transparency and conveyed nothing about the run", issue #154). **This confirms it directly: `RealTerminal` still exists as a fully-functional file and is still exported from the design system's public surface, but is dead code with zero real call sites.** A refactor should either delete it (and its export) or find it a legitimate new use.

### `src/renderer/src/ui/primitives/AnsiRenderer.tsx`
**Purpose:** Parses ANSI SGR color/style escape codes and renders styled `<span>`s — used inside `AgentTerminal`'s plain-text log feed.
**What it does:** Exports `parseAnsi(text)` and `AnsiRenderer({text, className})`. Supports basic + bright 16-color fg/bg, bold/dim/italic/underline, reset codes.
**Called from:** `AgentTerminal.tsx`.

### `src/renderer/src/ui/primitives/DecisionCard.tsx` — one decision with status badge, rationale, lineage, status-appropriate actions. **Called from:** `DecisionsPage.tsx`.
### `src/renderer/src/ui/primitives/QuestionCard.tsx` — one open question, evidence trail, options/free-text, Answer/Answer+Lock/View-Workflow actions. **Called from:** `QuestionsPage.tsx`.
### `src/renderer/src/ui/primitives/AgentCard.tsx` — one custom agent persona display. **Called from:** `AgentsPage.tsx`.
### `src/renderer/src/ui/primitives/ProviderCard.tsx` — LLM provider config card, API-key/local-endpoint scan flow. IPC: `window.forge.provider.scanModels`. **Called from:** `Settings.tsx`.
### `src/renderer/src/ui/primitives/StartWorkflowDialog.tsx` — "Start New Work" modal (template, title, requirements, scope paths). **Called from:** `WorkflowPage.tsx`.
### `src/renderer/src/ui/primitives/CreateTemplateDialog.tsx` — builds a custom multi-stage workflow template. **Called from:** `WorkflowPage.tsx`.
### `src/renderer/src/ui/primitives/CreateAgentDialog.tsx` — creates a custom agent persona. **Called from:** `AgentsPage.tsx`.
### `src/renderer/src/ui/primitives/AddProviderDialog.tsx` — adds a custom OpenAI-compatible/Messages-compatible provider. **Called from:** `Settings.tsx`.
### `src/renderer/src/ui/primitives/AddCliAgentDialog.tsx` — registers a custom CLI coding-agent runtime. **Called from:** `Settings.tsx`.
### `src/renderer/src/ui/primitives/AddMcpServerDialog.tsx` — registers a custom MCP tool server. **Called from:** `Settings.tsx`.
### `src/renderer/src/ui/primitives/WorkflowLaunchpad.tsx` — "no active workflow" landing view: hero CTA, template grid, assigned-agent roster. **Called from:** `WorkflowPage.tsx` (when `workflow === null`).

---

## Dev tools

### `src/renderer/src/dev/KitchenSink.tsx`
**Purpose:** Dev-only (`import.meta.env.DEV`-gated) showcase of every primitive in every variant.
**What it does:** Exports `KitchenSink()`. Tabs: Buttons, Forms, Feedback, Overlays. Exercises nearly every primitive listed above.
**Called from:** `Shell.tsx` (lazy-loaded only in dev builds).

---

## Summary of dead/unused code found (confirmed via grep — no imports outside the file itself, its own test, or the `ui/index.ts` barrel export)

1. **`ui/primitives/RealTerminal.tsx`** — fully working xterm.js + real PTY IPC terminal. Exported from `ui/index.ts` but not imported by any page. Deliberately abandoned per issue #154 (spawned a second CLI session, not the real one).
2. **`ui/primitives/DiffViewer.tsx`** — unified-diff viewer, superseded/duplicated by `CodeViewer.tsx`'s diff mode. Still exported from `ui/index.ts`.
3. **`app/workflow/WorkflowGraph.tsx`** — standalone pipeline graph, superseded by inline logic in `WorkflowPage.tsx`.
4. **`app/workflow/LiveLogViewer.tsx`** — standalone log viewer, superseded by `AgentTerminal` inside `WorkflowPage.tsx`.
5. **`app/workflow/WorkflowPreflight.tsx`** — pre-workflow readiness summary, superseded by `StartWorkflowDialog`/`WorkflowLaunchpad`.
6. **`app/DefaultBranchField.tsx`** — shared default-branch field component, never actually used by `CreateProjectDialog.tsx`/`EditProjectDialog.tsx`, which each reimplement similar logic inline instead.
7. **`app/AccountEnrollment.tsx`** — fully wired to real IPC but never mounted anywhere.
8. **`app/icons.tsx`: `TasksIcon`** — exported but no route named "Tasks" exists in `ROUTES`.

Also worth flagging: **`AgentTerminal`'s `onSendInput` prop and its input-bar UI** are present but never exercised (`WorkflowPage` never passes `onSendInput`) — correctly feature-gated off, matching the earlier "removed dead input box" fix, but could be removed from `AgentTerminalProps` entirely if truly dead. Additionally, **`StatusStrip.tsx`'s `workflowState` prop** is destructured from props but not visibly used in the rendered JSX.

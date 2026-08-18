# Architecture

How Forge is put together, and why. This describes the code as it stands; where
something is planned but not built, the issue is named.

## Processes

```
┌─────────────────────── MAIN (Node) ────────────────────────┐
│ owns: project truth · git · child processes · persistence  │
│                                                            │
│  src/main/index.ts        window, lifecycle, single instance│
│  src/main/security.ts     CSP · permissions · navigation    │
│  src/main/ipc/register.ts binds the router to ipcMain      │
│  src/main/ipc/router.ts   validation, no electron import   │
│  src/main/ipc/handlers.ts one handler per channel          │
└────────────────────────────┬───────────────────────────────┘
                             │  contextBridge, one channel per capability
┌────────────────────────────┴───────────────────────────────┐
│ PRELOAD  src/preload/index.ts                              │
│ named methods only · no channel argument reaches renderer  │
└────────────────────────────┬───────────────────────────────┘
                             │  window.forge.<domain>.<method>()
┌────────────────────────────┴───────────────────────────────┐
│ RENDERER (React)  no Node · no Electron · sandboxed        │
│                                                            │
│  src/renderer/src/app/    shell, routing, nav, UI store    │
│  src/renderer/src/ui/     tokens + primitives              │
│  src/renderer/src/ipc.ts  unwraps result envelopes         │
└────────────────────────────────────────────────────────────┘

           src/shared/   compiled into all three
                         pure data and pure functions only
```

`src/shared` may not import `electron`, `node:*`, `react`, or `react-dom` — it is
compiled into every target. Enforced by ESLint, not convention.

## The IPC contract

One declaration produces the channel list, the validation, and the types.

```
src/shared/ipc.ts
      │
      ├──> IPC_CHANNELS      what register.ts binds
      ├──> request schema     parsed in main before the handler runs
      ├──> response schema    parsed in main before crossing back
      └──> IpcChannel union   a typo is a compile error
```

A call, end to end:

```
renderer   forge.app.getInfo()
              │
preload    ipcRenderer.invoke('app:getInfo', {})
              │                 ↑ the only place a channel name is written
main       router: in contract? ──no──> UNKNOWN_CHANNEL
              │ yes
           parse request ──invalid──> INVALID_REQUEST   (handler never runs)
              │ valid
           handler ──throws──> HANDLER_FAILED
              │ returns
           parse response ──invalid──> INVALID_RESPONSE (never reaches renderer)
              │ valid
           { ok: true, value }
              │
renderer   unwrap() ──> value, or throws ForgeIpcError
```

### Why failures are returned, not thrown

`contextBridge` serializes errors **structurally**. Measured behaviour:

```
throw Error + own property   →  property stripped, name reset to "Error"
throw plain object           →  survives
return a result envelope     →  survives          ← what Forge does
```

So a thrown `ForgeIpcError` subclass loses its `code`. Preload returns an
`IpcResult`; `src/renderer/src/ipc.ts` turns it back into a real error, which also
puts the stack at the calling component rather than inside preload.

### Adding a capability

```
1. declare the channel in src/shared/ipc.ts    (request + response schema)
2. implement it in src/main/ipc/handlers.ts    (exhaustive map — compile error if missing)
3. expose a named method in src/preload/       (never a channel argument)
4. add the method to ForgeApi in src/preload/api.ts
```

Steps 2 and 3 cannot be verified against each other by the compiler — a channel with
no method is unreachable, and a method with no channel fails only when something
calls it. `scripts/smoke.cjs` compares the live bridge against `IPC_CHANNELS` from
the built bundle, so the pair is checked at runtime instead.

`handlers.ts` exports `createIpcHandlers(deps)` rather than a constant, because
domain handlers need the database, which is opened during startup. Passing the
dependencies in also lets the map be built against a temporary database in a test
without an Electron process — the same reason `router.ts` takes its handlers as a
parameter.

## Security posture

App-wide guards, distinct from the per-agent permission model in #37.

```
contextIsolation  on      nodeIntegration  off     sandbox  on
webviewTag        off     CSP              every response
permissions       all denied (camera, geolocation, notifications, …)
navigation        locked to the app origin; external links → OS browser
single instance   two orchestrators would contend over one db and one worktree
```

Production CSP allows no inline styles and no remote origins. The development
policy adds the Vite origin and `'unsafe-inline'`, which HMR requires.

**What Forge cannot enforce**, stated plainly: agent CLIs run as child processes
with the user's own OS privileges. Forge controls what it invokes, which paths it
declares writable, and what enters an agent's context — it is a guardrail, not a
sandbox. See #37.

## Renderer state

```
main (SQLite, event log)          renderer (zustand)
────────────────────────          ──────────────────
project · task · decision         sidebar collapsed
workflow · changeset              panel sizes
question · event                  view preferences
        ↑                                 ↑
   the truth (A1)              UI-only, meaningless elsewhere
```

Domain state must not be mirrored into the renderer store: a persisted copy would
diverge from the database *and* survive restarts, which is a second truth.

`projectStore` is the one store holding fetched domain data, and it obeys two rules
that keep the distinction intact:

```
mutate ──> main ──> re-read        never patch local state from the form
persist ──> selectedProjectId only  a pointer, not the rows
```

Repository facts — branch, head SHA, dirty state — are probed on every read rather
than stored at creation. The branch moves and commits land between one open and the
next, so a stored copy would go stale silently.

## Git as evidence

```
snapshot(before) ──> agent step runs ──> diffWorktree(baseSha)
       │                                        │
    baseSha                            files[] + patch  ──> ChangeSet
```

`GitService` (`src/main/git/`) is read-only: it has no commit, stage, branch, or
push method, and a test asserts that surface rather than leaving it to review. Write
operations arrive with the permission model (#37). This is what makes an agent's
claim checkable against the repository (A3).

### Why `git` is spawned directly, not wrapped

`simple-git` was the alternative. Spawning won because the formats consumed here —
`--porcelain=v2`, `--numstat`, `--name-status`, all with `-z` — are git's own
documented machine-readable contracts, so a wrapper would add a dependency tree and
a second parser without removing the need to understand them. `execFile` is used
with no shell, so a path or ref containing a space or `;` is an argument, not syntax.

Three format traps, each verified against `git 2.51` output rather than recalled:

```
--name-status -z   "M" \0 path                  2 fields
                   "R075" \0 old \0 new         3 fields — status letter sets arity
--numstat -z       "1\t0\tpath"                 1 field, tab-delimited
                   "1\t0\t" \0 old \0 new       3 fields, inline path EMPTY
                   "-\t-\tpath"                 binary: dashes, not integers
porcelain=v2 -z    "2 R. … R75 new" \0 old      new path first — reverse of diff
```

Because arity depends on the status letter, records cannot be read in fixed strides.
Binary files report `-` where `ChangedFile` requires a non-negative integer, so they
map to `0` with a `binary` flag — zero-because-binary stays distinguishable from
zero-because-unchanged.

The subtlest one, caught by a test rather than by review:

```
git diff <base>  ──> tracked content only
                     a file the agent CREATED is invisible
```

An untracked file is the most common kind of agent change, and it was silently
missing from the changeset. `git add -N` would fix the diff but writes to the index —
unacceptable in a read-only service operating on a repository an agent may still be
editing. Untracked paths therefore come from `status`, and each is diffed against
the null device with `--no-index`, which exits 1 by design when the files differ.

## Agent runtimes (A6)

```
application layer ──> IAgentRuntime ──> RuntimeRegistry.resolveForRole(id, role)
                            ▲
        ┌───────────────────┼───────────────────┐
   MockAgentRuntime    ClaudeCliRuntime    (a second provider)
        └──────── src/main/runtimes/ ───────────┘
                  the ONLY place a provider may be named
```

Roles are bound by **capability, not identity**: any runtime may hold any role it
declares the capabilities for, which is what makes planner and builder swappable. The
check happens when a binding is made, not when a step runs — a read-only runtime bound
as the implementer would otherwise fail only once a workflow was already in flight.

Two ESLint rules enforce A6, because a comment is not a boundary:

```
no-restricted-imports   core may not import a concrete runtime
no-restricted-syntax    no provider name as a string or template literal in core
```

Both were verified by planting a violation and confirming they fire.

This indirection is what let the #20 spike's finding — Antigravity ships no headless
CLI — become a scoping decision rather than a rewrite.

### Everything an agent says is a claim

```
AgentReport.filesChanged   claimed  ──> reconciled against git diff   (#34)
AgentReport.testsRun       claimed  ──> Forge runs the tests itself   (#33)
AgentReport.assumptions    MUST be empty — R1 makes one a violation
```

`MockAgentRuntime` mutates a real worktree rather than only returning a report. That is
what makes the dishonest scenarios meaningful: `liar` leaves the tree untouched while
claiming otherwise, and a test proves it with `git diff` instead of trusting a fixture.

The event stream ends on `dispose`, **not** on reaching a terminal state — a caller
driving several steps would otherwise lose every event after the first step completed.
The waiter is installed in the same synchronous turn as the empty-queue check; setting
it after an `await` loses any event emitted in between, which is a lost wakeup that hung
every scenario whose step performed no file edit.

## Rules and the effective policy

```
global ──> workspace ──> project ──> workflow ──> agent ──> task
                 most-specific scope wins on conflict
```

`resolveEffectivePolicy` (`src/shared/domain/policy.ts`) is a pure function, in
`shared` so main resolves the policy it sends and the renderer resolves the same
answer it shows — one implementation rather than two that can disagree.

Rules are prose statements keyed by a stable `key`. Same key at two scopes means the
*same concern*, and the narrower one wins; different keys accumulate. The loser is
**kept** as `shadowed` rather than discarded, because "this rule is overridden" is
what the settings screen has to show — a silent override is how a global safety rule
disappears unnoticed.

```
FORGE_DEFAULT_RULES  R1..R8, code constants, global scope
                     ↓ merged on every read
project rules        rows, projected from rule.set / rule.removed events
                     ↓
effective policy     resolved fresh, never cached
```

The eight defaults from `docs/FORGE_RULES.md` are code constants, not rows: they are
Forge's own policy, they must exist for the axioms to mean anything, and a narrower
scope may override one but nothing can delete it. A test compares them against the
document's headings, since a doc that disagrees with the enforced policy is worse
than no doc.

Ordering is by codepoint, not `localeCompare`: the resolved text goes into prompt
packets that are snapshotted and compared, and `localeCompare` reads the host's
locale, so the same policy could order one way locally and another in CI.

## Design system

```
pages ──> primitives ──> tokens
```

A page imports from `@renderer/ui` and never styles what a primitive covers. A
primitive references tokens and never writes a literal colour. `ui/tokens.css` is
the only place a hex value appears. Both boundaries are lint-enforced. See
`src/renderer/src/ui/README.md`.

## Verification layers

Each layer answers a question the others cannot.

```
npm run test          logic and primitives            node + jsdom
npm run check:router  boundary rules                  plain node, no electron
npm run smoke         isolation · CSP · bridge        real electron
npm run check:ui      computed styles · themes        real electron
npm run test:e2e      the app's own startup path      real electron, playwright
```

Assertions target observable behaviour, not source text. An early version of
`check:ui` grepped the built CSS and reported zero utilities while the browser was
resolving them correctly — Tailwind minifies and escapes selectors, so a literal
search produces false negatives.

## Build

```
electron-vite ──┬──> out/main/index.js        app entry
                ├──> out/main/router.js       so check:router runs in plain node
                ├──> out/main/security.js     so smoke asserts the real CSP
                ├──> out/preload/index.cjs    cjs: a sandboxed preload cannot be ESM
                └──> out/renderer/            html + assets
```

Two traps worth remembering:

- a sandboxed preload **cannot** be an ES module — it is emitted as `.cjs`, and
  `main` must load that exact extension
- `electron@43` ships **no postinstall of its own**, so this project declares one.
  `npm rebuild electron` does not fetch the binary; only `npm install` / `npm ci`
  do

## Not yet built

| Area | Issue |
|------|-------|
| git write operations, gated by permissions | #37 |
| agent runtime adapters (pty, real CLIs) | #23 → #26 |
| workflow engine, context engine | #27 → #32 |
| evidence, policy engine | #33 → #37 |
| questions, decision lock, diff UI | #38 → #42 |

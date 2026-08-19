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

## Reconciliation: claims against reality

This is where A3 stops being a promise.

```
report.filesChanged   ──┐
real git diff         ──┼──> reconcile
task.scope            ──┘        ├── claimed but unchanged   discrepancy, LOOPS
                                 ├── changed but unclaimed   discrepancy, LOOPS
                                 └── outside allowedPaths    HALTS
```

Both directions of mismatch matter, for different reasons:

```
claimed but unchanged   the work was not done            the `liar` scenario
changed but unclaimed   the agent does not know what it did
```

The second is worse. An agent that misreports its own edits cannot be reasoned with about
them on the next iteration.

### Dishonesty loops; a scope breach halts

The distinction the design rests on. A dishonest claim goes back as a **review finding** —
that is the correction loop working as intended. An out-of-scope edit is a **policy breach**:
the agent touched something the task forbade, and continuing would build on a change the user
never sanctioned (A7).

So `scopeCreep` halts even though its report is perfectly *honest* — it reports the forbidden
edit accurately. The violation is the edit, not the report.

```
one file -> one discrepancy
```

A path that is both out of scope and unreported yields **one** finding, not two: scope is the
more serious fact and the run halts either way, so whether the agent also mentioned it is
moot. Honesty is still judged on the unfiltered comparison, or an unreported forbidden edit
would count as an accurate claim.

### Scope policy

```
forbiddenPaths wins over allowedPaths     a prohibition is not "unless something permits it"
empty allowedPaths = anywhere not forbidden   the common case early in a project
```

Defaulting an empty allow list to "nothing is allowed" would halt every workflow until
someone wrote a glob.

### The glob matcher is hand-written

`src/shared` may not import anything environment-specific, and the one matcher already in the
tree (`picomatch`) is a transitive dependency of a build tool — relying on it would break the
day that tool changes its own dependencies. Every semantic was **measured against picomatch**
rather than recalled, because a policy that quietly matches more than the user wrote lets an
agent edit forbidden files, and one that matches less halts legitimate work. Both fail
silently.

```
src/DS      matches src/a.ts, src/deep/b.ts, AND src itself
src/S       matches src/a.ts but NOT src/deep/b.ts
DS/*.ts     matches a.ts at depth ZERO as well as src/a.ts
```

(That last case is the one a naive implementation misses: the leading `**/` has nothing to
consume.)

## The orchestrator

The point where everything built separately becomes a loop.

```
template step ──> binding ──> registry ──> runtime
      │                                       │
 checkpoint (write-ahead, #28)         exchange(packet, #26)
      │                                       │
 guards: budgets · no-progress (#29)   validated report
      │                                       │
      └────────> transition (#27) ──> next step
```

It **coordinates and does not decide**. Is this move legal? The transition table. Is the
budget spent? The guards. Is this report acceptable? `assessReport`. That keeps it small
enough to read, and means a policy question has exactly one place to be answered.

### A template names roles, never runtimes

```
1  planner       ──> binding ──> some runtime
2  user          ──> approval gate, no runtime
3  implementer   ──> binding ──> some runtime
4  system        ──> Forge verifies: build, test, diff scope
5  reviewer      ──> binding ──> some runtime
```

Swapping which runtime plans and which implements is a change to **binding data**, never to
code (A6). A test asserts exactly that: two runtimes, bindings swapped, same template, same
result. Another asserts the template JSON mentions no provider at all.

`DECISIONS_LOCKED` deliberately has no template step — arriving there *is* the locking, and
the machine passes straight through. Giving it a step would run the implementer twice, once
from each state.

### Capability checks happen at bind time

```
bindRole()  ──> runtime lacks the capability ──> IncapableRuntimeError, naming it
precheck()  ──> unbound role · unregistered runtime · invalid template
```

Both before any work happens. A read-only runtime bound as the implementer, or a missing
reviewer discovered at step five, has already spent an agent's time and left a half-finished
change.

### Permissions are the intersection of role and request

```
planner     read only            a plan that could write is an implementation (#42)
reviewer    read + tests         one that could fix what it found would not report it
gitWrite    never                the final commit is the user's call, this MVP
```

A project may **narrow** a role but never widen it. A settings screen that could grant an
implementer's write access to a reviewer would make the role distinction decorative (A7).

### One bug worth recording

The no-progress guard fingerprints the worktree diff. A planner and a reviewer legitimately
change nothing, so their diffs are identically empty — feeding those to the detector tripped
it on the *first* implementer step and halted a perfectly good run with "no progress". The
guard was right and the input was wrong: fingerprinting is now limited to roles that hold
`writeFiles`. Found by the end-to-end test, which is the only place it could surface.

## The context engine

```
task + locked decisions + rules + files + previous attempt + findings
                          │
                select ─> rank ─> budget ─> redact
                          │
                 PromptPacket  (snapshotted, content-addressed)
```

Never send the whole history. An agent given five hundred messages performs worse than one
given the eight facts that matter, and costs more. Three properties are enforced rather than
trusted:

```
deterministic    identical state -> byte-identical packet
redacted         no .env, no key material, nothing secret-shaped   (A7, R7)
decisions        locked ones verbatim, NEVER truncated             (A4)
```

Determinism comes from two specific choices: ties break on path, and comparison is by
codepoint rather than `localeCompare` — which reads the host locale, so a packet would order
differently on another machine and break every snapshot comparison.

### Redaction is two mechanisms, not one

```
path-level    .env · *.pem · id_rsa · .aws/ · .npmrc · secrets*   excluded WHOLESALE
value-level   bearer tokens · KEY=value · JWTs · PEM · user:pass@   scrubbed
```

A `.env` is excluded rather than scrubbed line by line, because it can hold a hostname or a
feature flag that looks harmless and is still nobody's business. Value-level scrubbing exists
in addition because a secret can arrive through an objective, a review finding, or an
answered question — not only through a file.

`redactSecrets` lives in `shared/domain/redaction.ts` and is used by both the packet compiler
and the process logger (#23). Two copies would drift, and the one that drifted would be the
one that leaked.

**Forbidden paths lose to nothing.** The strongest ranking signal is "the task names this
file", and it still loses to A7 — otherwise a task objective could be used to extract a
credential.

### Selection is per role

```
planner            12 files, no findings, no previous attempt
implementer        25 files, both
reviewer           15 files, both — the diff arrives as previousAttempt
system · user       0 files — Forge performs these itself
```

A caller cannot widen a role's view past its strategy; `maxFiles` is a `min` of the two.

### Truncation is explicit

An agent that does not know its view was trimmed will reason as though it saw everything and
confidently conclude something wrong. `truncationNotice()` names what was dropped and invites
the agent to ask.

### Packets are content-addressed

```
reference = sha256(canonical json)[:32]
```

The reference *is* the hash, so identical context writes one file, and a reference cannot
resolve to a packet edited since — the hash would no longer match, and `load` returns null
rather than the altered packet. A sequential id would only say "the packet that was here".

```
JSON.stringify trap, measured:
  stringify(obj, sortedTopLevelKeys, 2)  ->  EVERY nested object becomes {}
```

The replacer-array form applies the key list at *every* depth, so `previousAttempt` serialised
as `{}` and `answeredQuestions` lost its contents — a snapshot that would replay the wrong
context with nothing to indicate anything was missing. Keys are sorted by rebuilding the
object instead.

## Loop guards (A5)

The failure mode these exist to prevent:

```
planner → builder → reviewer → builder → reviewer → ...   forever
```

Two agents can exchange work indefinitely, each plausibly making progress, until the quota
is gone. Every guard answers one question: *is it still reasonable to continue?*

```
iteration cap     5      transition table, on the correctionStarted edge
step wall clock   30m    checkBudgets
step idle         10m    checkBudgets  (also enforced in the pty, #23)
total wall clock  4h     checkBudgets  — reported BEFORE a per-step budget
retries           3      decideRetry, fixed 5s backoff
no progress       —      detectNoProgress, on the diff not the report
stop-on toggles   —      checkStopConditions
```

All pure functions in `src/shared/domain/guards.ts`. The engine calls them and acts; nothing
there spawns, kills, or waits — which is what makes a retry budget interacting with a wall
clock testable without a running workflow.

### Transient vs semantic

The distinction that matters most:

```
transient   the same request could plausibly succeed unchanged   -> retry
semantic    it could not                                          -> never retry
```

Retrying a bad credential or a policy violation spends the budget on a certainty and delays
the halt the user needs to see. Fixed backoff rather than exponential: exponential earns its
complexity when many clients contend for one resource, whereas a single workflow retrying
its own local step only takes longer to admit defeat.

### No progress is measured on the diff

```
fingerprint = sorted(path:+n:-n) + hash(patch)
two CONSECUTIVE iterations with the same fingerprint  ->  HALTED_LIMIT
```

Fingerprinted from what git shows, not from the report, because the case being caught is an
agent resubmitting identical work while describing it differently each round (A3). Only
*consecutive* repeats count — two identical diffs with a different one between them is a
loop that tried something else, which is progress even if it was reverted.

It fires on the **second** identical attempt, so a spinning loop stops immediately instead of
burning the full iteration budget first.

### Limits come through the rules chain

```
global ──> workspace ──> project ──> workflow ──> agent ──> task
rule key: limit.maxIterations · limit.stopOn.buildFailure · …
```

Reusing the rules engine rather than adding a parallel settings mechanism means one
inheritance implementation, and an overridden limit shows up in the settings screen with its
provenance like any other rule. A malformed value is *reported*, never silently ignored: a
project that meant to cap iterations at 3 and typed `three` must not quietly run with 5.

`stopOn.permissionViolation` is typed `true` rather than `boolean`. A7 is not a preference,
and a toggle that could disable it would make the guarantee advisory.

```
zod trap, measured:  .default({})   value used AS-IS, inner defaults SKIPPED
                     .prefault({})  value PARSED, inner defaults applied
```

`.default({})` on `stopOn` yielded a bare `{}`, so `unexpectedFileModification` came back
`undefined` and the guard silently stopped firing. Caught by a test.

## Crash recovery

```
checkpoint(step) ──> event persisted ──> side effect ──> result event persisted
       │                                     │
  killed here                          killed here
       │                                     │
  resume: redo the step                 resume: continue
```

The event is written **before** the side effect runs. That ordering is why a crash is
recoverable rather than merely survivable: if the record of what was being attempted is
written only afterwards, a process killed mid-step leaves no trace of the step and resume
has to guess. Writing first means the worst case is a step *redone*, not a step lost —
which is why steps must be idempotent.

"Interrupted" needs no flag; it falls out of the ordering:

```
checkpoint IS NOT NULL  AND  finishedAt IS NULL   ->  something was in flight
```

A checkpoint is written before a step's side effects and cleared when the workflow
finishes, so its presence on an unfinished workflow means the process died mid-step.

**Idempotency is a property of the projections.** Every workflow writer is an upsert or an
absolute `set`, never a read-modify-write — an `iteration = iteration + 1` would
double-count on every replay, and a resume re-applies the tail of the log by design. A test
rebuilds twice and asserts the state is unchanged.

A resumed step replays the **snapshotted packet** (`checkpoint.inputRef`), not a freshly
compiled one: project state has moved on since the crash, so recompiling would send
different context than the step was attempting, and the resumed run would not be the
interrupted one.

### Orphaned processes

`killAll()` covers an orderly quit. It cannot cover being killed — no hook runs, and the
spawned agents keep working against the repository.

```
spawn ──> record pid to disk ──> ... crash ...
                                     │
                       next start: read the record
                                     │
                       alive? ──yes──> kill      ──no──> forget
                       owner still alive? ──> leave alone (another Forge)
```

The owner check matters more than it looks: killing a *second live instance's* agents would
be worse than leaving an orphan, so a record whose owner is still running is skipped rather
than reaped.

## Child processes

```
ProcessManager.spawn ──> node-pty ──> stream ──> exit
        │                   │
        │                   ├── idle timeout   no output for N ms ──> killed, reported
        │                   └── hard timeout   wall clock exceeded ──> killed, reported
        │
        ├── cancel   posix: SIGINT ─> SIGTERM ─> SIGKILL    win32: pty.kill()
        ├── cap of 2 concurrent, further starts queue
        └── killAll() on before-quit, so nothing is orphaned
```

A pty rather than pipes because the CLIs Forge drives are interactive programs: several
change behaviour when stdout is not a TTY, and some refuse to run at all.

`node-pty@1.1.0` ships prebuilds for **darwin-arm64/x64 and win32-arm64/x64 — but not
linux-x64**, so it loads untouched on Windows and macOS and must be compiled on Linux.
CI is what established that: Windows passed while Linux failed with `Cannot find module
'./prebuilds/linux-x64//pty.node'`. `npm run setup` builds it only where no prebuild
exists; `npm run setup:pty` is the pty alone, for the CI job that runs the tests but
never launches the app. Where a prebuild does exist it is N-API, so one binary serves
both plain Node and Electron — the same property that made `better-sqlite3` work here.

### Four platform behaviours, each measured

```
1. Windows has no signals
   pty.kill('SIGINT')  ->  throws "Signals not supported on windows."
                           from inside a DEFERRED callback, so try/catch
                           cannot catch it — it becomes uncaught
   pty.kill()          ->  kills the ConPTY agent, which owns the console
                           the whole child tree is attached to

2. Windows does not search PATH
   spawn('git', …)     ->  throws "File not found:"
   => Forge resolves bare names itself, honouring PATHEXT. Not via a shell,
      which would reintroduce the injection surface GitService avoids.

3. ConPTY splices control codes mid-word
   git --version  ->  …[H g  ESC]0;…\git.exe BEL  ESC[?25h it version 2.51.0
                          ↑ the title sequence lands inside the word
   => /git version/ does NOT match raw output. Stripped before storing.

4. Output arrives before exit, with a silent tail
   last chunk ~2535ms, process exit ~3546ms  — an ~800ms gap
   => an idle timeout must exceed the tail, not just the inter-chunk gap,
      or a healthy process is killed as it finishes
```

### Quitting

`before-quit` starts the kills; `will-quit` closes the database. Deliberately **not**
`preventDefault()` with a re-issued `app.quit()` — that cancels the quit sequence, and
the re-issued quit then races a shutdown Electron has already abandoned. Measured: it
hung `app.close()` and took the e2e suite from 4s to a 30s teardown timeout.

### Secrets (R7)

```
into the process    parent env is filtered by NAME SHAPE, default drop
out of the logs     output scrubbed by VALUE SHAPE before storing or emitting
```

Filtering is by shape rather than by vendor, which is both R7 and A6: a list naming
providers would miss the next one and would put provider names into core. A guardrail,
not a guarantee — a child runs with the user's own privileges and can read `.env`
itself. The point is that Forge does not help, and that a captured log is safe to attach
to a workflow step.

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

### The wire protocol

This is the layer that replaces the user as the message bus.

```
PromptPacket ─render─> text ─> agent ─> stdout ─extract─> JSON ─validate─> AgentReport
                                            │                     │
                                      no fence found        schema failure
                                            └──── re-prompt ONCE with the error ────┘
                                                          │
                                                    still bad -> fail the step
```

Reports are delimited by `FORGE_REPORT_BEGIN` / `FORGE_REPORT_END` rather than a
```` ```json ```` fence: agents emit those constantly for ordinary code samples, so a
generic fence cannot be told apart from the report.

Tolerant about surroundings, strict about content. Narration before and after the block is
normal and must not fail; a report missing a field fails even if it looks plausible. Two
concessions to how models actually behave, each with a test:

```
a ```json fence INSIDE the sentinels   -> stripped, not rejected
the sentinel quoted in the report      -> last end fence wins, so it still parses
```

Burning the single retry on formatting rather than substance would waste it.

Exactly one re-prompt, and it carries the **actual validation error** — a vague "invalid
report" would make the second attempt a guess, which defeats the point of validating with
a schema. A second failure fails the step: a model that cannot follow the protocol twice
will not follow it a third time.

Parsing lives in `shared/domain/protocol.ts` (pure) and the exchange in
`main/runtimes/exchange.ts` (drives a runtime). The split is what makes the interesting
cases testable without a runtime.

### What a valid report *means* is a separate judgement

```
parse    did the agent answer in the required shape?
assess   what does the answer mean for the workflow?
```

A valid report can still halt the run:

```
assumptions[] non-empty  -> halt-assumption   R1: a violation, not a footnote
status question + asks   -> await-user        route to the queue, pause
status question, no ask  -> halt-blocked      nothing to queue, nothing to wait for
status blocked           -> halt-blocked
status completed         -> accept            a CLAIM entering verification
```

The assumption check runs **before** status, deliberately. An agent admitting an assumption
while claiming `completed` is exactly how R1 gets violated in practice, and taking `status`
at face value first would let it through.

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
| real CLI adapters | #24 #25 |
| workflow UI (graph, live log, resume banner) | #32 |
| build/test runners, verdicts, policy engine | #33 #35 #36 #37 |
| questions, decision lock, diff UI | #38 → #42 |

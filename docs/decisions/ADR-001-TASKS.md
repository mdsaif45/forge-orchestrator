# ADR-001 — implementation task list

Sequenced. Each task states what proves it done. Numbers are provisional issue
slots, to be filed as real issues before work starts (no TODO without an issue).

---

## Phase 0 — get the branch mergeable and honest (do first, blocks everything)

```
T1  restore A3: delete the synthesized-report fallback
    src/main/runtimes/exchange.ts:272
    a second malformed reply must fail the step, not become
    { status:'completed', testsRun:false }. 14d145f already fixed this once
    ("stop fabricating success reports"); it returned one layer up.
    PROVES: new test — agent replies twice with prose and no fence -> step fails
            with failure:'protocol', workflow does not reach DONE.

T2  restore A3: narrow the salvage regex, or drop it
    src/main/runtimes/exchange.ts:219
    /(\{[\s\S]*?"status"[\s\S]*?\})/ matches the first brace span containing
    "status" anywhere in the reply — including JSON the agent quoted from the
    repository. Unknown status strings coerce to 'completed'.
    Keep only the fenced-block branch; treat an unrecognised status as malformed.
    PROVES: test — reply quoting a package.json containing "status" is NOT
            parsed as a report.

T3  restore A5: make preflight block again
    src/renderer/src/app/workflow/WorkflowPreflight.tsx
    every blocker is blocking:false. A missing test command must block an
    autoRun workflow: a git diff proves files changed, not that they are correct.
    PROVES: existing preflight test asserting the A3 wording, reinstated.

T4  npm run format:check -> green
    37 files fail; CI's first job is red, so the branch cannot merge.
    PROVES: npm run check exits 0.

T5  backfill commit hygiene going forward
    every commit since 2026-08-26 is subject-only, no body, no Closes #N.
    Not rewriting history; the rule applies from here.
```

## Phase 1 — provider catalog (the ADR's core)

```
T6  shared/domain: ProviderKind = 'cli' | 'api'
    a CLI entry declares: id, executable, argv builder, output parser,
    resume flag, probe command, repository-instruction filenames.
    Replaces two hardcoded adapters with data. Keeps A6: core never names a
    provider; src/main/runtimes/* stays the only place allowed to.
    PROVES: registering a third CLI requires no change outside the catalog.

T7  register opencode as the third CLI runtime
    measured surface: `opencode run <message>`, plus `serve` (headless server)
    and `acp` (Agent Client Protocol) as structured alternatives.
    Its configured model failed to connect on this machine — the catalog probe
    must report that as an unhealthy provider, not a Forge failure.
    PROVES: probe reports opencode reachable/unreachable without throwing.

T8  api-key provider kind
    direct LLM call, key in SecretStore only. Never SQLite, never the
    append-only event log (unrevocable).
    PROVES: a test asserting no key text appears in the event log or DB after a
            run — assert observable state, not source text.

T9  agent builder binds persona -> provider -> role
    Alex/Rhea/Kai. Capability check on binding already exists
    (canHoldRole / IncapableRuntimeError) — reuse it, do not reinvent.
    PROVES: binding a read-only provider to builder is refused with the missing
            capability named.
```

## Phase 2 — remove account isolation (38 files)

```
T10 stop overriding HOME/USERPROFILE at spawn
    src/main/accounts/accountAuth.ts:25 + claudeCliRuntime spawn path.
    This one edit is what unblocks #64.
    PROVES: FORGE_REAL_AGENT=1 run passes with no login step.

T11 delete src/main/accounts/** and AccountEnrollment.tsx
    drop IAgentRuntime.supportsAccountIsolation and session.options.accountId.
    PROVES: lint + typecheck clean, no dangling reference in the 38 files.

T12 forward migration dropping the accounts table
    0002_accounts.sql stays; add 0003 dropping it. Keep
    workflow_steps.account_id unused for now so an existing DB still opens.
    After schema.ts changes: npm run db:generate, commit the generated
    migrations/*.sql AND migrations.generated.ts together.
    PROVES: db:check clean; an existing forge.db opens without loss.
```

## Phase 3 — transparency (decision 2)

```
T13 live CLI pane per workflow step
    ~80% built already on this branch: RealTerminal, AgentTerminal,
    AnsiRenderer, terminalService, node-pty + xterm.js.
    Bind the pane to the step's actual spawned process rather than a separate
    session, so what the user watches IS the run.
    PROVES: a UI check asserting the pane's text contains the step's real
            output — ask the runtime, not the file.

T14 tests for terminalService
    new subsystem, spawns processes, currently zero tests.
    Windows traps already known: no POSIX signals (no-arg pty.kill()),
    CreateProcess ignores PATH, ConPTY splices OSC sequences mid-word.
    PROVES: spawn/data/exit/kill covered; teardown uses removeTempDir.
```

## Phase 4 — prove the loop end to end (the actual goal)

```
T15 unskip and run the real-agent test
    FORGE_REAL_AGENT=1. Already proven runnable by hand:
      claude -p --output-format json          -> exit 0, real turn
      agy --output-format json -p='...'       -> exit 0, real turn
    Note agy's Go flag parsing: -p=<prompt> attached, never -p <prompt>
    (separated, it eats the next flag as its prompt — the adapter is already
    correct; do not "fix" it).
    PROVES: a real turn through Forge's own adapter, per provider.

T16 dogfood against a scratch repo, read the trace
    FORGE_DOGFOOD=<path> FORGE_DOGFOOD_REPORT=trace.txt
    The recorded prior result is "timed out with the repository untouched".
    Expect T1/T2 to change what this shows: the synthesized report was very
    likely masking the real stall. Fix what the trace actually shows, not what
    seems likely.
    PROVES: workflow reaches DONE, no step verdict 'fail', repository modified.

T17 multi-provider run: planner on one CLI, builder on another
    the ADR's actual claim, and the thing never yet demonstrated.
    PROVES: one workflow, two providers, zero copy-paste.
```

## Phase 5 — housekeeping

```
T18 README status is stale and wrong
    still says "Pre-alpha, in M0 ... No agent orchestration exists yet — that
    begins at M2." M0-M6 are closed and orchestration exists.

T19 close the finished milestones and their epics on GitHub
    all 7 still state:open including 6 with zero open issues; epics never
    auto-close. Verify counts via the API first.

T20 close #62/#63/#64 citing ADR-001, and file the --safe-mode trade-off
    as its own issue.

T21 renderer bundle is 1.71 MB with no code splitting (deferred, file it).
```

---

## Order and why

```
T1..T4  ── correctness + mergeable ──┐
                                     ├─> T15..T17 real end-to-end
T6..T9  ── catalog ──> T10..T12 ─────┤    (T10 is what unblocks #64)
                                     │
T13,T14 ── transparency ─────────────┘

T18..T21 anytime
```

T1 and T2 come first for one reason: the "resilience" added to make runs succeed
is hiding the failure it was meant to fix. Running T16 before T1 would measure
the mask, not the defect.

# Forge — Session Handoff

Read this first in a new Claude Code session on this repo. Snapshot of where things
stand and what to do next. This is a session artifact, **never committed to a
feature branch** — permanent docs are `README.md`, `docs/ARCHITECTURE.md`,
`docs/DOMAIN.md`, `docs/PLAN.md`, `docs/FORGE_RULES.md`, `CONTRIBUTING.md`,
`CLAUDE.md`.

## What Forge is

AI engineering control plane: multiple coding agents (Claude, Antigravity, others)
collaborate on one repo under a shared execution protocol. **Forge owns state;
agents are replaceable workers that do work and report back.**

```
A1  Forge owns truth      event log + projections are the DB; agents emit
                          events, never write state directly
A2  Never guess           ambiguity -> a question, not an assumption
A3  Evidence over claims  agent says "done"; Forge verifies before trusting
A4  Decisions are locked  approved decisions can't be silently overridden
A5  Bounded autonomy      scoped permissions, not free rein
A6  Provider-agnostic     no code path assumes "Claude" or "Antigravity"
A7  Legible by design     every entity/state inspectable, not opaque
```

## Status — verified 2026-08-24, not assumed

`main` at `8465e29`. `npm run check` exit 0 on a clean tree:

```
52 test files · 706 unit · 7 router · 8 smoke · 13 UI · 13 e2e · docs-drift ok
packaged: dist/win-unpacked/Forge.exe (electron-builder)
```

Milestone issue counts, from `gh api repos/mdsaif45/forge-orchestrator/milestones`:

```
M0 Foundation          13 closed   0 open
M1 State Core          10 closed   0 open
M2 Runtime Adapters     8 closed   3 open   <- the only open work
M3 Workflow Engine      7 closed   0 open
M4 Evidence & Review    6 closed   0 open
M5 Human Control Plane  7 closed   0 open
M6 Polish & Scale       6 closed   0 open
```

**Housekeeping gap:** every milestone is still `state: open` on GitHub, including
the six with zero open issues. Their epic issues likely need manual closing too —
epics never auto-close, because no PR carries `Closes #<epic>`. Verify with the
API before closing anything; don't assume the counts above are still current.

## The design source is fully consumed

`chatgpt-chat/ChatGPT-Agent Orchestration Design-*.md` (2362 lines, 30 numbered
sections + a settings addendum) is the origin spec. Every concept in it maps to
shipped code — checked section by section:

```
spec §                     code
-----------------------------------------------------------------------
3   Project State          shared/domain/{project,workflow,event}.ts
4   never guess            main/questions/ + probe-before-ask
5   bounded loops          shared/domain/guards.ts
6   Claude != boss         shared/domain/runtime.ts + runtimes/bindings.ts
7/8 account|agent|session  main/accounts/ + accountSwitch.integration.test
9   multi project          main/projects/
10  git first-class        main/git/gitService.ts  (read-only by design)
11  change ownership       main/changesets/ + renderer ChangesPage
12  structured comms       shared/domain/protocol.ts  (REPORT fence)
13  Context Compiler       shared/domain/contextEngine.ts
14/15 UI + workflow screen renderer/app/workflow/{Graph,LiveLog,Inspector}
16  discussion vs impl     enforced structurally, not by prompt
17  Decision Lock + CR     main/decisions/
18  one Question Queue     main/questions/ + QuestionsPage
19  Evidence               main/evidence/{commandRunner,verifier}.ts
20  failure recovery       main/db/workflowStore.ts  (write-ahead checkpoint)
21  Electron arch          main+preload+renderer, lint-enforced boundaries
22  reusable UI            renderer/ui/primitives + semantic tokens
25/26 MVP loop             main/acceptance/  (zero copy-paste test)
28  trust evidence         evidence can override a reviewer's verdict
29  templates as data      shared/domain/template.ts  (5 templates)
settings layers            layered settings + scope provenance UI
permissions                shared/domain/policyEngine.ts
```

Nothing in the spec is unbuilt. Do not re-plan from that file — read it only for
intent behind an existing module.

## The 3 open issues are all blocked on the USER, not on code

```
#62 DECISION  Is orchestrated CLI use permitted on a Pro subscription, and
              what are the programmatic rate limits?
              -> needs a vendor terms answer. Cannot be resolved from code.

#63 DECISION  Which runtime holds the builder role, given Antigravity ships
              no headless CLI (proven in the #20 spike, see
              docs/spikes/agent-cli-capability.md)?
              -> needs an architecture call from the owner. See below.

#64 SPIKE     Re-run the authenticated leg of #20: real turn, session resume,
              cancel mid-edit.
              -> needs an interactive logged-in CLI session. Cannot run
                 headless, so cannot run in CI or in an agent session.
```

### Why #63 is the load-bearing one

`IAgentRuntime` is the seam that makes A6 real:

```
core ──> IAgentRuntime ──┬─> ClaudeCliRuntime       spawn via pty — works
                         ├─> AntigravityCliRuntime  no headless CLI to drive
                         └─> MockAgentRuntime       tests
```

Antigravity is a windowed IDE; a GUI cannot be driven by a pty spawn. So the
"builder" role has no second real provider. Three ways out:

```
dual-Claude (2 accounts, 2 roles)   works today, keeps A3 intact
wait for an Antigravity headless CLI  indefinite
GUI automation adapter              fragile, and breaks A3 — you cannot get
                                    trustworthy evidence out of a screen-scrape
```

Until the owner picks, the multi-agent premise runs on one vendor. The adapters
for both exist; only Antigravity's has nothing real to talk to.

## Rules being followed (lint, CI, or standing user instruction)

### Coding

1. **Never guess (A2).** Check installed APIs before coding against them:
   `npm view <pkg> version`, `npm view <pkg> peerDependencies`,
   `node -e "console.log(Object.keys(require('<pkg>')))"`. Real mismatches hit
   in this repo: zod v4 vs v3 API, `@vitest/coverage-v8` pinning a nonexistent
   `vitest`, node-pty prebuilds (darwin/win32 only, **not** linux-x64). Still
   ambiguous after inspecting repo/config/history — **ask**.
2. **Evidence over claims (A3), including about my own work.** Run the command,
   read the output. Assert observable *behaviour*, not source text — a CSS check
   once grepped built output and reported zero classes while the browser resolved
   them fine (Tailwind minifies/escapes selectors). Ask the runtime, not the file.
3. **TypeScript strict, no `any`, no non-null assertions in app code.**
4. **Comments explain WHY, never WHAT.** Trap: a literal `**` + `/` inside a
   `/** */` block closes it early and breaks the build — write it in prose when
   documenting glob syntax.
5. **Reuse, don't reinvent.** Renderer: only `@renderer/ui` primitives
   (lint-enforced). Variants describe intent (`danger`), not appearance (`red`).
   Tokens are semantic (`--color-surface-raised`), not descriptive.
6. **Tests wait on conditions, not durations.** No `sleep(n)`; poll a bounded
   loop so a real regression still fails. Shared helper: `src/test/tempDir.ts`.
7. **Name a real problem in a sentence and keep going.** Don't route around a
   defect. Two examples: a Linux CI sandbox failure could have been dodged with
   `--no-sandbox`, which would have disabled the isolation the check exists to
   verify — the permissions were fixed instead. `will-quit` + `preventDefault`
   looked right for killing children on quit but hung `app.close()` for 30s —
   measured, moved to `before-quit`.
8. **Delete rather than comment out.** No `TODO` without an issue number.
9. **Zod v4 `.default({})` vs `.prefault({})`** — hit twice. `.default()` uses
   the fallback as-is, skipping the inner schema's own field defaults;
   `.prefault()` parses the fallback *through* the schema. Any new optional
   nested-object field needs `.prefault({})`.
10. **Boundaries are lint errors, not conventions:**
    ```
    renderer  cannot import electron · node:* · fs · path · child_process
              cannot deep-import ui/primitives/* -> import from '@renderer/ui'
    shared    cannot import electron · node:* · react · react-dom
    ```
11. **Windows traps already found — don't rediscover:**
    - No POSIX signals: `pty.kill(signal)` throws uncatchably from a deferred
      callback; use no-arg `pty.kill()` on win32.
    - `CreateProcess` does not search `PATH` — resolve command + `PATHEXT` first.
    - ConPTY splices OSC title sequences mid-word into output — strip ANSI/OSC
      before parsing agent output.
    - 8.3 short names break string path equality, and Node's `realpath` does
      **not** expand them (measured) — compare `stat().dev` + `stat().ino`,
      string-compare only as a fallback for paths that don't exist yet.
    - `localeCompare` / default `Array.sort()` is host-locale dependent — use
      explicit codepoint comparison for any order that is observable.
    - A directory is locked until every process using it has fully exited, so a
      delete right after `kill` fails EBUSY. Use `removeTempDir` from
      `src/test/tempDir.ts` in `afterEach`, never a bare `rmSync`.

### Git / GitHub

1. **Never push to `main`** — protected, rejects even the owner's token.
2. **Flow:** issue -> branch -> commits -> `npm run check` green -> PR -> CI
   green -> user says "yes"/"CONTINUE" -> `gh pr merge --squash --delete-branch`.
3. **Branches:** `feat/<issue>-<slug>`, `fix/`, `docs/`, `chore/`, `test/`,
   `spike/` — matching the issue's `type:` label.
4. **Commits:** conventional prefix, imperative mood, body explaining *why*
   including anything surprising found. End with `Closes #<issue>` on its own
   line. **Never add a `Co-Authored-By` / AI attribution trailer, in any repo** —
   standing global instruction; omit it, don't ask.
5. **PR body:** design decisions (not just the diff), real bugs the tests caught,
   exact verification counts (not "tests pass"), DoD checklist mapped to the
   issue's bullets, and a "Deferred" section naming what was left out and which
   issue picks it up.
6. **Epics never auto-close.** Close them manually once the last child merges;
   verify counts via `gh api repos/<owner>/<repo>/milestones` first.
7. **Merge only after explicit user approval**, even when CI is fully green.
8. **Push credential workaround** (Windows Credential Manager caches a stale
   username and plain `git push` hangs on a password prompt):
   ```bash
   GH_TOKEN=$(gh auth token) && git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f" push -u origin <branch>
   ```
9. **`gh pr checks <n>`** for CI; poll bounded, never fixed-sleep. Three checks
   gate every PR: `Format, lint, types, tests`, `App checks (Electron)`,
   `App checks (Windows)`.
10. **`HANDOFF.md` is never committed to a feature branch.** Before staging:
    `git add -A && git restore --staged HANDOFF.md`.

### Verification gate

```bash
npm run check
```

Order: `format:check` -> `lint` -> `typecheck` -> `test` -> `build` ->
`check:router` -> `smoke` -> `check:ui` -> `test:e2e` -> docs-drift
(`docs/DOMAIN.md`'s generated Mermaid must match `transitions.ts`).

Isolate a failure with `npm run lint` / `typecheck` / `test` / `build` /
`test:e2e` / `check:docs`. After any `src/main/db/schema.ts` change run
`npm run db:generate` and commit the generated `migrations/*.sql` +
`migrations.generated.ts` together.

### Environment quirks

- **`npm run setup` after `npm ci`** — `.npmrc` sets `ignore-scripts=true`
  deliberately, so native modules (`better-sqlite3`, the Electron binary) don't
  auto-rebuild. Run it manually.
- **`scripts/setup-native.mjs`** rebuilds node-pty via node-gyp only where no
  prebuild ships (Linux x64). Don't "fix" it for platforms that have one.
- **node-pty prints `Error: AttachConsole failed`** to stderr during Node-side
  unit runs on Windows. Pre-existing ConPTY noise, not a failure — check the
  test counts and exit code, not stderr.
- **No `python`/`python3` on the Bash tool's PATH** — use Node one-liners or the
  `Edit` tool, not Python heredocs.
- **Backticks/template literals in `node -e "..."` inside bash heredocs** break
  shell escaping — write a throwaway `.mjs` or use `Edit`.
- **CI matrix:** `ubuntu-latest` (lint/types/tests + Electron smoke/e2e under
  `xvfb`) and `windows-latest` (same suite natively — it has caught real
  Windows-only bugs: node-pty's missing linux-x64 prebuild, signal handling).

## How to resume

```bash
cd D:\my-quests\side-projects\Forge
git status                      # expect clean on main
git pull --ff-only origin main  # expect 8465e29 or later
npm run check                   # expect exit 0
```

Then, in priority order:

1. **Answer #63** (and #62) — unblocks the last real code work. Nothing else in
   the repo is blocked.
2. **Run #64** — needs the owner's authenticated CLI session; an agent cannot.
3. **Close the finished milestones and their epics** on GitHub (see the
   housekeeping gap above).
4. **Dogfood** — point Forge at a real repository and drive one workflow end to
   end. Every subsystem is unit- and e2e-tested, but the product has not been
   run against an outside project; that is where the next real defects are.

# Working on Forge

Conventions for coding agents contributing to this repository. Forge enforces
these rules on the agents it orchestrates; they apply just as much to agents
building it.

## Read first

```
README.md              what Forge is · the seven axioms
docs/ARCHITECTURE.md   processes · IPC contract · verification layers
docs/DOMAIN.md         entities · state machine  (specification, not yet code)
docs/PLAN.md           milestones · known toolchain traps
docs/FORGE_RULES.md    the agent policy set Forge itself enforces
CONTRIBUTING.md        branch flow · commands · lint-enforced boundaries
```

## The rules that will fail your work

### Never guess (A2)

If something is undetermined, inspect the repository, the configuration, the
related implementation, and the project history. If it is still ambiguous, **ask** —
do not pick a plausible option and continue. A wrong assumption that compiles is
worse than a question, because it survives review.

This applies to library APIs too. Check the installed version's actual surface
rather than recalling it:

```bash
npm view <pkg> version
npm view <pkg> peerDependencies
node -e "console.log(Object.keys(require('<pkg>')))"
```

Several versions I first wrote in this repo were stale, and two peer ranges did not
overlap at all. Checking took seconds; the wrong pairing would have taken a debug
session.

### Evidence over claims (A3)

Do not report success you have not observed. Run the command and read the output.

```bash
npm run check    # format → lint → types → test → build → router → smoke → ui → e2e
```

A green typecheck is not a working app: an earlier commit built cleanly while the
preload was emitted as `.mjs` and the app would have failed to load at runtime.
That is why the smoke checks exist.

**Assert observable behaviour, not source text.** An early design-system check
grepped the built CSS and reported zero utilities generated, while the browser was
resolving them correctly — Tailwind minifies and escapes selectors. Ask the
runtime, not the file.

### Boundaries are lint errors

```
renderer   ✗ electron · node:* · fs · path · child_process
           ✗ deep imports into ui/primitives/*   → import from '@renderer/ui'
shared     ✗ electron · node:* · react · react-dom
```

The renderer store holds UI state only. Domain state lives in main behind the IPC
contract (A1).

### Tests must wait on conditions, not durations

A `sleep` or a fixed number of frames encodes one machine's timing into the test.
Poll until the condition holds, bounded so a real regression still fails:

```js
for (let i = 0; i < 120 && read() !== expected; i += 1) {
  await new Promise((r) => requestAnimationFrame(r))
}
```

A check in this repo passed four consecutive local runs and still failed on a
slower CI machine. Repetition on one host does not establish determinism.

## Style

Match the surrounding code. Specifically:

```
TypeScript strict, no `any`, no non-null assertions in app code
comments explain WHY, never what the next line already says
variants describe intent (`danger`), not appearance (`red`)
tokens are semantic (`--color-surface-raised`), not descriptive (`--color-gray-800`)
accessibility is structural: a required `label` prop beats a review reminder
```

Delete code rather than commenting it out. Do not leave a `TODO` without an issue
number.

## Workflow

```
issue ──> branch ──> commits ──> npm run check ──> PR ──> owner approves ──> merge
```

Never push to `main`; it is protected and will reject the push. Branch names are
`feat/<issue>-<slug>`, `fix/`, `chore/`, `docs/`, or `spike/`.

Commit messages: conventional prefix, imperative mood, and a body that explains
the reasoning — including anything surprising you found. Do not add AI co-author
trailers.

A pull request should state what was verified and how, and name anything deferred
along with the issue that will do it. Say plainly what you did not finish; a
partial change described accurately is useful, and one described as complete is a
liability.

## When you find a real problem

Say so in a sentence and keep going. Do not silently narrow the task, and do not
work around a defect you could name. If a fix would grow beyond the issue's scope,
file it and reference it rather than folding it in.

Two examples from this repo's history:

- the fix for a Linux CI failure could have been `--no-sandbox`, which would have
  turned the process-isolation checks green **while disabling the isolation they
  exist to verify**. Correcting the helper's permissions kept the guarantee real.
- `electron@43` ships no postinstall, and `npm rebuild electron` does not fetch
  the binary. The workaround worked; the root cause was worth finding, because the
  obvious repair command does not work.

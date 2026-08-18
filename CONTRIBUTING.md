# Contributing to Forge

## Branch flow — always

```
issue ──> feature branch ──> commits ──> PR ──> review ──> merge (owner approves)
```

Never commit directly to `main`. Every change goes through a pull request, and a
PR is merged only on explicit owner approval.

## Branch naming

```
feat/<issue>-<slug>      feat/14-domain-model
fix/<issue>-<slug>        fix/31-resume-race
chore/<issue>-<slug>      chore/12-ci-pipeline
docs/<issue>-<slug>       docs/13-architecture
spike/<issue>-<slug>      spike/20-cli-capability
```

## Commits

Conventional commits, imperative mood, one logical change per commit.

```
feat(core): add append-only event log
fix(runtime): kill process tree on cancel
docs(readme): document the seven axioms
```

## PR requirements

- [ ] links its issue with `Closes #N`
- [ ] CI green: lint, typecheck, tests, build
- [ ] no `any` introduced
- [ ] UI work reuses `ui/` primitives — no one-off components
- [ ] the seven axioms in the README are not violated
- [ ] tests cover the new behaviour

## Verification

One command runs everything CI runs:

```bash
npm run check
```

```
format:check -> lint -> typecheck -> test -> build
             -> check:router -> smoke -> check:ui -> test:e2e
```

| Layer | Command | What it proves |
|-------|---------|----------------|
| unit / component | `npm run test` | logic and primitives, in Node and jsdom |
| contract | `npm run check:router` | IPC boundary rules, no Electron needed |
| process | `npm run smoke` | isolation, CSP, bridge — in real Electron |
| design system | `npm run check:ui` | computed styles, themes, routing |
| end to end | `npm run test:e2e` | the real app's own startup path |

Prefer asserting **observable behaviour** over source text. Reading a build
artifact to confirm something works produces false negatives — an early version
of `check:ui` grepped the emitted CSS and reported zero utilities while the
browser was resolving them correctly.

### Native binaries

`.npmrc` sets `ignore-scripts`. This is deliberate, and worth understanding
before removing it:

```
better-sqlite3   ships a binding.gyp, so npm runs `node-gyp rebuild` even though
                 the package sets gypfile:false. It ALSO ships working N-API
                 prebuilds, so the compile is unnecessary — and it fails outright
                 on any machine without a C++ toolchain, including CI.
esbuild          platform binary arrives as an optional dependency, no script.
electron         ships no postinstall of its own, so its binary must be fetched.
```

So a fresh clone is:

```bash
npm ci
npm run setup   # Electron's binary only
```

CI's `static` job skips `setup` entirely — it never launches the app, which saves
roughly 100MB per run. `npm rebuild electron` does **not** fetch the binary.

## Architectural boundaries, enforced by lint

These are not review conventions — they fail `npm run lint`:

```
renderer  ✗ electron, node:*, fs, path, child_process
          ✗ deep imports into ui/primitives/*   (use '@renderer/ui')
shared    ✗ electron, node:*, react, react-dom  (compiles into all 3 targets)
```

The renderer store holds **UI state only**. Domain state — project, task,
decision, workflow, changeset, question — lives in main behind the IPC contract,
because Forge owns the project truth (axiom A1).

## Working on Forge with coding agents

See `CLAUDE.md`. The rules Forge enforces on agents also apply to agents building Forge.

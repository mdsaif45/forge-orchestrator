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

## Working on Forge with coding agents

See `CLAUDE.md`. The rules Forge enforces on agents also apply to agents building Forge.

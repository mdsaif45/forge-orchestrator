# Security Policy

## Supported versions

Forge is pre-alpha. Only the most recent release receives security fixes, and
there is no long-term support branch yet.

| Version | Supported |
| ------- | --------- |
| 0.1.x-alpha | yes |
| < 0.1.0 | no |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting instead:

1. Go to the [Security tab](https://github.com/mdsaif45/forge-orchestrator/security)
2. Click **Report a vulnerability**

That channel is private between you and the maintainer until a fix is published.

Please include what you were doing, what happened, and ideally a way to
reproduce it. A report that lets the problem be reproduced is worth far more
than one that describes it abstractly.

Expect an acknowledgement within a week. This is a solo side project, so
timelines are best-effort rather than contractual.

## What is in scope

Forge orchestrates coding agents against a local repository, spawns CLI
processes, and stores project state in a local SQLite database. Findings in
these areas are especially relevant:

- **Command execution** — a path where a repository's contents, an agent's
  output, or a workflow template causes an unintended command to run
- **Path containment** — an agent or workflow reaching outside the configured
  repository path
- **Secret exposure** — credentials, tokens, or environment values reaching the
  event log, the SQLite database, a log file, an exported report, or a prompt
  packet. The event log is append-only and replayable, so a secret written
  there cannot simply be deleted
- **Process isolation** — a way for the renderer to reach Node APIs, or for the
  preload bridge to expose more than its declared surface
- **Policy bypass** — evading the per-role permission model, the dangerous
  command checks, or the scope enforcement that limits which paths a role may
  modify

## What is out of scope

- The behaviour of the third-party agent CLIs Forge drives. Report those to
  their own vendors
- Unsigned release binaries. This is known and documented in the release notes;
  code signing is not yet configured
- The default Electron application icon
- Anything requiring an attacker to already have local code execution as the
  user running Forge

## A note on this project's own threat model

Forge deliberately trusts the user and distrusts agent output. Guardrails such
as `--permission-mode` on a spawned CLI are treated as guardrails, not as a
sandbox, and `docs/ARCHITECTURE.md` states this. A finding that an agent could
misbehave when explicitly granted permission to do so is expected behaviour; a
finding that it could do so *without* that grant is a vulnerability.

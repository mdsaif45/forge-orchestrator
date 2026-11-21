# Security, Trust & Isolation Posture

**Status:** IMPLEMENTED  
**Authority:** Normative Security Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [concurrency-and-isolation.md](concurrency-and-isolation.md)  
**Related Specifications:** `docs/FORGE_RULES.md`, [rules-and-policy.md](../specifications/rules-and-policy.md)  
**Related Implementation:** `src/main/security.ts`, `src/shared/domain/policyEngine.ts`  

---

## 1. Security Philosophy: Honest Enforcement Limits

Forge takes an explicit and honest stance regarding execution security:

> **Guardrails are policy enforcers, not an OS sandbox.** 

A determined native agent running in a local developer environment cannot be fully prevented from escaping if it has arbitrary shell execution privileges. True sandboxing requires hardware virtualization (e.g. Firecracker microVMs or Docker containers with dropped capabilities). 

Forge enforces **application-level guardrails** to prevent accidental destruction, detect policy violations, and redact sensitive data. The engine makes no false claims of cryptographic isolation on bare metal.

---

## 2. Least Privilege Scoping (Axiom A7)

Permissions are enforced structurally by Forge, not politely requested through prompt instructions:

```
┌──────────────┐     Attempts file write
│   PLANNER    │ ────────────────────────────► HALTED_POLICY (Immediate termination)
└──────────────┘

┌──────────────┐     Writes outside allowedPaths
│ IMPLEMENTER  │ ────────────────────────────► HALTED_POLICY (Worktree reverted)
└──────────────┘

┌──────────────┐     Attempts git write / branch move
│   REVIEWER   │ ────────────────────────────► HALTED_POLICY (Read-only git allowed)
└──────────────┘
```

- **Planner Role**: Strict read-only file access. The `planner` role declares only `repo-read` and `plan`, so the mutating tools (`write_file`, `edit_file`) are never offered to it.
- **Implementer Role**: Scoped strictly to task `allowedPaths`. Writes to sensitive directories (`.git/`, `.env`, migrations, lockfiles) halt execution.
- **Reviewer Role**: Can run compilers and test suites, but cannot execute file modification tools.

---

## 3. Dangerous Command Guards

Commands are assessed by `assessCommandPolicy()` against `DANGEROUS_COMMANDS` in
`src/shared/domain/policyEngine.ts`. The list below is the complete set on `main`; each
entry carries a machine-readable name and a stated reason.

| Name | Guards against |
| :--- | :--- |
| `git-force-push` | Force push overwriting remote history |
| `git-reset-hard` | Hard reset discarding uncommitted work |
| `git-clean-force` | Force clean deleting untracked files |
| `git-branch-force-delete` | Force branch delete/rename losing refs |
| `rm-rf-root-or-wildcard` | Recursive deletion of root, wildcard, home or relative-root paths |
| `package-publish` | `npm`/`yarn`/`pnpm publish` from an autonomous agent |
| `pipe-remote-to-shell` | `curl`/`wget` piped into a shell interpreter |

A match returns a `PolicyViolation` and the command is not allowed to run.

> An earlier revision of this page listed `mkfs`, `format`, `diskpart`, `dd if=`, fork
> bombs and `git config --global`. None of those patterns exist in the engine. The
> genuine list above is narrower in some places and wider in others.

---

## 4. Secret Exclusion & Redaction (Rule R7)

To prevent API keys, database credentials, and tokens from leaking into agent prompt packets, terminal logs, or SQLite databases:

### 1. Child Environment Filtering
Before spawning any agent CLI or evidence child process, Forge clones `process.env` and strips secret-shaped variables:
`src/main/process/redact.ts` matches variable **names** case-insensitively against
`SECRET_NAME_PATTERNS`: `token`, `secret`, `password`, `passwd`, `pwd`, `api[-_]?key`,
`access[-_]?key`, `private[-_]?key`, `credential`, `session[-_]?id`, `auth`, and
`npm_config__auth`.

The list is deliberately about *shape* rather than vendor: a rule naming providers
would miss the next one, and would put provider names in core in violation of A6.

`ALLOWED_NAMES` lets `GIT_TERMINAL_PROMPT` and `GIT_ASKPASS` through despite matching,
because they are not secrets and some tools need them to decide whether to prompt.

### 2. Stream Redaction
All output captured from stdout, stderr, or PTY byte streams passes through the redactor before being written to disk (`ArtifactService`) or forwarded over IPC:
- High-entropy strings matching common API key signatures (Anthropic, OpenAI, AWS, GitHub PATs) are replaced with `[REDACTED_SECRET]`.

---

## 5. Workspace Trust & Pre-Launch Automation

When modern developer CLIs (such as Claude Code) execute in an unfamiliar directory, they halt execution with an interactive security prompt:
```
Accessing workspace: C:\Temp\f166-8Cc765
Quick safety check: Is this a project you created or one you trust?
```

Because Forge generates an isolated git worktree per session, this prompt would freeze headless automation. Forge handles this safely via the `ClaudeTrustStore`:
- Forge inspects the parent project path. If the parent repository is marked as trusted by the user, Forge automatically pre-records trust for the ephemeral worktree path in `~/.claude.json` **before** process launch.
- The CLI boots straight into the prompt loop without freezing.

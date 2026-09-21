# Security, Trust & Isolation Posture

**Status:** IMPLEMENTED  
**Authority:** Normative Security Architecture  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
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
│   BUILDER    │ ────────────────────────────► HALTED_POLICY (Worktree reverted)
└──────────────┘

┌──────────────┐     Attempts git write / branch move
│   REVIEWER   │ ────────────────────────────► HALTED_POLICY (Read-only git allowed)
└──────────────┘
```

- **Planner Role**: Strict read-only file access. Tools like `writeFile` and `bashRun` are withheld or configured with write blocks.
- **Builder Role**: Scoped strictly to task `allowedPaths`. Writes to sensitive directories (`.git/`, `.env`, migrations, lockfiles) halt execution.
- **Reviewer Role**: Can run compilers and test suites, but cannot execute file modification tools.

---

## 3. Dangerous Command Guards

Commands executed through `bashRun` or evidence runners are inspected against an explicit denylist of destructive patterns:
- Recursive directory removal on root or home paths (`rm -rf /`, `rmdir /s /q C:\`).
- Partition and disk utilities (`mkfs`, `format`, `diskpart`, `dd if=`).
- Fork bombs and memory exhausters.
- Attempts to modify user git credentials (`git config --global`).

If a command matches a forbidden pattern, the runner rejects the execution and halts the run with a `POLICY_VIOLATION` event.

---

## 4. Secret Exclusion & Redaction (Rule R7)

To prevent API keys, database credentials, and tokens from leaking into agent prompt packets, terminal logs, or SQLite databases:

### 1. Child Environment Filtering
Before spawning any agent CLI or evidence child process, Forge clones `process.env` and strips secret-shaped variables:
- Any variable containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, or `CREDENTIAL` is withheld from the child process unless explicitly whitelisted in project settings.

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

# Core Engineering Principles & Axioms

**Status:** FROZEN  
**Authority:** Canonical Engineering Principles  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [architecture-overview.md](../architecture/architecture-overview.md), [evidence-and-verification.md](../architecture/evidence-and-verification.md)  
**Related Specifications:** [rules-and-policy.md](../specifications/rules-and-policy.md), `docs/FORGE_RULES.md`  

---

## 1. The Seven Invariant Axioms

Forge enforces seven foundational axioms across every subsystem. These are not conventions or guidelines; they are enforced by compiler types, unit tests, and runtime guards.

```
A1  FORGE owns truth.      Agents perform work. Chat transcripts != project state.
A2  UNKNOWN != ASSUME.     Probe repository -> probe config -> probe history -> 
                           still unclear -> OPEN QUESTION -> WAIT for human.
A3  Evidence > claims.     Agent says "tests pass"   -> Forge runs the test suite.
                           Agent says "3 files"      -> Forge runs git diff.
A4  Decisions LOCK.        A locked decision changes only via user-approved Change Request.
A5  Bounded loops.         Every workflow has max iterations, timeouts, and no-progress halts.
A6  No provider in core.   Core sees IAgentRuntime only; CLIs and models live in adapters.
A7  Least privilege.       Per-role permissions enforced by Forge, not requested by prompt.
```

---

## 2. Deep Dive into Axioms

### Axiom A1 — Forge Owns Truth
An agent's internal memory or chat transcript is not system state. It is ephemeral, drifts over time, and cannot be audited or replayed. Forge stores state in durable, structured storage:
- SQLite databases for runs, steps, events, and artifact metadata.
- Content-addressed files on disk for prompt packets, logs, and patches.
- Git worktrees for file changes and commit history.
Agents read a compiled, deterministic view of state and report findings back.

### Axiom A2 — Unknown Is Not an Assumption
When an agent or subsystem encounters an ambiguity:
1. Probe the repository files.
2. Probe local project configuration.
3. Probe version control and commit history.
4. Probe previous workflow steps and locked decisions.
If the question cannot be resolved by evidence, the engine **must pause** in `AWAITING_USER` and present a structured `OpenQuestion`. An agent is never permitted to invent a missing requirement.

### Axiom A3 — Evidence Over Claims
An agent's natural language summary is an unverified assertion. 
- When an agent claims "All 15 tests pass", Forge ignores the text and executes the configured test command in a dedicated child process, checking exit codes and stdout.
- When an agent claims "Modified `src/index.ts`", Forge runs `git diff` against the base SHA to identify the exact physical changes.
- Discrepancies between agent claims and physical facts are recorded as discrepancies or policy breaches.

### Axiom A4 — Decisions Lock
Architectural and design decisions made during planning are versioned and locked into SQLite. Once locked:
- Downstream steps (Implementation, Verification, Review) cannot alter the decision.
- Any change requires explicit user approval through a formal Change Request transition.
- An agent attempting to bypass a locked decision is halted with `HALTED_POLICY`.

### Axiom A5 — Bounded Loops
Unsupervised agent loops burn tokens, money, and time without guaranteed convergence. Forge bounds all execution through:
1. **Iteration Caps**: Hard ceiling on the number of correction loops (`maxIterations`).
2. **Wall-Clock Timeouts**: Fixed timeout per process and per workflow step.
3. **No-Progress Detection**: If consecutive correction iterations produce an identical git diff, the engine halts immediately rather than looping until the cap.
4. **Explicit Terminal States**: All workflows must terminate in `DONE`, `HALTED_LIMIT`, `HALTED_POLICY`, or `CANCELLED`.

### Axiom A6 — No Provider in Core
The Forge orchestration kernel (`ForgeCore`, `WorkflowEngine`, `TaskRunner`) contains zero imports or knowledge of Anthropic, OpenAI, Google, Ollama, or third-party CLI tools.
- All agent interactions flow through the abstract `IAgentRuntime` interface.
- CLI runners, PTY terminal spawners, and API clients exist exclusively in `src/main/runtimes/` or external packages.

### Axiom A7 — Least Privilege
Permissions are enforced by the engine, not requested by prompt engineering:
- A `planner` role has strict read-only access; any file write halts execution with `HALTED_POLICY`.
- An `implementer` role has write access restricted to declared paths (`allowedPaths`).
- A `reviewer` role can execute read-only tests and inspect diffs, but cannot modify files.
- The working tree base branch is protected from direct git writes.

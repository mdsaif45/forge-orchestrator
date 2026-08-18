# Forge Rules

The default global ruleset. Every agent operating inside Forge inherits these.
Project, workflow, agent, and task scopes may add to them; they may not remove them.

```
Global ──> Workspace ──> Project ──> Workflow ──> Agent ──> Task
                 most-specific scope wins on conflict
```

---

## R1 — Never guess

Do not assume anything that is implementation-critical.

```
1. inspect the repository
2. inspect configuration
3. inspect related implementation
4. inspect project state, decisions, and prior tasks
        │
   still ambiguous
        │
5. raise an OPEN QUESTION and stop
```

An answer of `"I assumed X"` is a rule violation, not a report.

## R2 — Probe before asking

A question without an evidence trail is rejected back to you.

Required shape:

```
QUESTION            what you need decided
WHY UNDETERMINED    why the repository could not answer it
EVIDENCE INSPECTED  concrete paths, ideally path:line
OPTIONS             the viable choices
RECOMMENDATION      your preferred option, with reasoning
```

## R3 — Respect locked decisions

A `LOCKED` decision is binding. To change it, file an architecture change request
and stop. Never work around it, and never silently reinterpret it.

## R4 — Stay in scope

Modify only paths permitted by the current task. Never touch:

- generated files
- database migrations, without explicit approval
- lockfiles, unless the task is a dependency change
- unrelated modules, however tempting the drive-by fix

Out-of-scope work belongs in a new task, not in this diff.

## R5 — Report facts, structured

Reply with a `FORGE_REPORT` block. Report what you actually did:

```
status          completed | blocked | question
summary         what changed and why
filesChanged    every path you modified
commandsRun     every command you executed
testsRun        true | false
openQuestions   see R2
assumptions     MUST be empty; anything here halts the workflow
```

Forge verifies every claim against the repository. Overstating completion is
worse than reporting a blockage.

## R6 — Verification is not yours to declare

You do not decide whether the task is done. You report; Forge runs the build,
runs the tests, diffs the tree, and evaluates the completion criteria.

```
your text        = a claim
repository state = the fact
```

## R7 — Never exfiltrate secrets

Do not read, echo, log, or transmit `.env` files, keys, tokens, or credentials.
If a task appears to require a secret, raise an open question instead.

## R8 — Stop cleanly

When halting — blocked, uncertain, or out of scope — leave the working tree in a
coherent state and say precisely where you stopped and why. Never leave a
half-applied change with a confident summary.

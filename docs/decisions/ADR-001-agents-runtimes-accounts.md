# ADR-001 — Agents, runtimes, and the end of account isolation

Status: **accepted** · Date: 2026-08-31 · Supersedes: #62, #63, #64

Closes the three questions that blocked M2. All three were treated as open because
they were framed as vendor or subscription questions. They are not: two rest on
facts that were measured wrong, and one is a product decision the owner has now
made.

---

## Context

M2 stalled on three "blocked on the user" items:

```
#62 DECISION  is orchestrated CLI use permitted on a Pro plan, and what are the
              programmatic rate limits?
#63 DECISION  which runtime holds the builder role, given Antigravity ships no
              headless CLI?
#64 SPIKE     re-run the authenticated leg of #20 — real turn, resume, cancel
```

Everything else in the repository was complete. These three kept the multi-agent
premise theoretical.

---

## Decision

### 1. Forge does not model accounts, plans, or quota (#62)

An agent is created from one of two provider kinds:

```
kind: cli      claude-code · antigravity · opencode · (extensible)
               spawned as a child process, inherits the machine's own login

kind: api      any LLM reachable by API key
               key held in SecretStore, never in SQLite or the event log
```

Forge holds no credential for a CLI provider and asks no question about the
user's subscription tier. If the CLI runs for the user in their own terminal, it
runs under Forge. Rate limits surface as what they are — a provider error on a
step, already modelled as a named halt with remedies (#147) — not as something
Forge predicts or manages.

**Consequence:** one identity per CLI provider, the machine's. Multi-account is
out of scope, not deferred.

### 2. Any runtime may hold any role, and every run is visible (#63)

Roles stay bindings, never identities (A6). An agent is a named persona bound to a
provider and a role:

```
Alex   Planner    <- claude-code
Rhea   Builder    <- antigravity
Kai    Reviewer   <- opencode
```

Forge renders each step's CLI process live, in-app, as the real terminal it is —
Forge writes the opening prompt, the CLI runs unmodified, the user watches. The
next step may bind a different provider entirely.

### 3. Forge reuses the machine's existing CLI logins (#64)

No enrolment, no browser flow, no Forge-managed home directory.

---

## Why #63 and #64 were not actually blocked

Both premises were false. Measured on this machine, 2026-08-31:

```
$ claude -p --output-format json --permission-mode plan   (prompt on stdin)
  -> {"subtype":"success","is_error":false,...,"result":"...FORGE_OK"}   exit 0

$ agy --output-format json -p='Reply with exactly: FORGE_OK'
  -> {"status":"SUCCESS","response":"FORGE_OK\n","num_turns":1,...}      exit 0
```

**Antigravity ships a headless CLI.** `agy --help` lists `-p/--print`,
`--output-format json|stream-json`, `--continue`, `--conversation <id>` (resume),
`--mode`, `--model`, `--json-schema`. The #20 spike concluded it was a windowed
IDE that a pty could not drive; that conclusion is obsolete. The load-bearing
question of #63 — "the builder role has no second real provider" — has no subject.

**Neither CLI required a login.** Both returned a real turn on the credentials
already on the machine. The authentication #64 was waiting for was never a vendor
requirement. It was self-inflicted:

```
real credential    ~/.claude/.credentials.json
Forge spawned with HOME=<forge>/accounts/<id>/home    (empty, by design)
                        -> CLI finds no credential -> demands a fresh login
```

`accountEnv()` (`src/main/accounts/accountAuth.ts:25`) overrides `HOME` and
`USERPROFILE` so a spawned CLI reads an isolated home. That is exactly what makes
an existing login invisible. Account isolation and credential reuse are the same
mechanism pointed in opposite directions — #62's answer removes the override, and
#64 becomes an ordinary run.

`opencode run` reached its runner and failed to contact its configured model
(`google/gemma-4-e2b`, "Unable to connect"). That is provider configuration on
this machine, not a capability gap; opencode also exposes `serve` (headless
server) and `acp` for a structured path.

---

## What this removes

Account isolation is not disabled behind a flag. It is deleted, because a dormant
credential mechanism is a liability and `supportsAccountIsolation` currently shapes
adapter design. 38 files reference it today.

```
src/main/accounts/**                     accountHomes · accountAuth · accountService
                                         enrollmentService · terminalLauncher (+tests)
accountEnv() HOME/USERPROFILE override   the defect behind #64
IAgentRuntime.supportsAccountIsolation   no longer a concept
session.options.accountId                replaced by the binding's provider
accounts table · 0002_accounts.sql       superseded by a forward migration
AccountEnrollment.tsx + Settings surface
```

Migration is forward-only: a new migration drops the table, and
`workflow_steps.account_id` is retained but unused until a later cleanup, so an
existing database opens without loss.

---

## What this does not change

```
A1 Forge owns truth      unchanged — the event log is still the state
A3 evidence over claims  unchanged, and see the note below
A4 decisions lock        unchanged
A5 bounded loops         unchanged
A6 no provider in core   strengthened — a catalog replaces two named adapters
A7 least privilege       unchanged — permission mode is still derived per role
```

---

## Open trade-off, deliberately not decided here

`claude` is spawned with `--safe-mode`, which strips the ambient configuration a
spawned agent would otherwise inherit — `CLAUDE.md`, plugins, hooks, MCP servers.
It exists for a real reason: a `UserPromptSubmit` hook on this machine once
blocked Forge's prompt outright, so the agent never saw it. Forge decides what
enters an agent's context (A1), and #145 re-injects the repository's own
instructions deliberately, as data in the packet.

That sits in tension with "the CLI runs unmodified" (decision 2). The measured run
above succeeded *without* `--safe-mode`. Dropping it would let a machine-local hook
silently intercept a packet again; keeping it means the CLI is not quite running as
the user's own.

Not resolved in this ADR. Tracked as its own issue.

---

## Consequences

Positive:

- the multi-agent premise becomes real on this machine today, on three providers
- no credential ever enters Forge for a CLI provider
- the largest remaining subsystem is deleted rather than maintained
- adding a provider becomes a catalog entry, not an architecture change

Negative:

- one identity per CLI provider; running two accounts of one provider is gone
- Forge inherits whatever the machine's CLI configuration is, including surprises
- `agy` and `opencode` argument shapes are undocumented surface that can drift;
  each needs a probe in the catalog and a real-run test to catch a change

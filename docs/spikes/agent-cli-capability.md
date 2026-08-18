# Spike — can the agent CLIs be driven headlessly on Pro accounts?

Issue #20. Timeboxed spike, run before any real adapter (#21–#26).

Everything downstream assumes Forge can spawn each CLI, feed it an instruction, parse
what it did, and cancel it. This is what was actually measured on the development
machine, with commands run and their real output.

```
environment
  Windows 11, git 2.51.0.windows.2, node 22.20.0
  claude          2.1.209  (npm -g @anthropic-ai/claude-code)
  Antigravity     GUI app, Antigravity IDE 1.107.0 (VS Code fork)
  date            2026-08-19
```

## Verdict

| Provider | Headless? | Verdict | Blocks M2? |
|----------|-----------|---------|-----------|
| Claude Code CLI | yes — `-p` with `--output-format json` / `stream-json` | **GO**, conditional on auth | no |
| Antigravity | **no** — no headless entry point found | **NO-GO as a spawned CLI** | yes, for the builder role |

```
Claude       spawn -> stdin prompt -> stdout NDJSON -> exit code   WORKS
Antigravity  spawn -> opens a GUI window -> no stdout -> hangs     DOES NOT WORK
```

The MVP loop (planner → builder → reviewer) **cannot be built on two spawned CLIs
today.** Options are in "Fallback plan" below; this needs a decision (#62).

---

## Claude Code CLI

### Headless invocation — CONFIRMED

`-p/--print` is the documented non-interactive mode. From `claude --help`:

```
-p, --print    Print response and exit (useful for pipes). Note: The workspace
               trust dialog is skipped when Claude is run in non-interactive
               mode (via -p, or when stdout is not a TTY, e.g. piped or ...)
```

### Machine-readable output — CONFIRMED, three formats

```
--output-format text          default, prose only
--output-format json          one result envelope
--output-format stream-json   NDJSON, realtime (needs --verbose)
--input-format  stream-json   realtime streaming input
--include-partial-messages    token-level chunks (stream-json only)
--json-schema <schema>        structured output against a schema
```

Real `--output-format json` envelope, captured verbatim (unauthenticated run):

```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":null,
 "duration_ms":993,"duration_api_ms":0,"num_turns":1,
 "result":"Failed to authenticate: OAuth session expired and could not be refreshed",
 "stop_reason":"stop_sequence","session_id":"70cfeb56-fc6a-4264-acf9-4b748dd8e3c3",
 "total_cost_usd":0,"usage":{...},"permission_denials":[], ...}
```

Full key set:

```
type · subtype · is_error · api_error_status · duration_ms · duration_api_ms
num_turns · result · stop_reason · session_id · total_cost_usd · usage
modelUsage · permission_denials · terminal_reason · fast_mode_state · uuid
```

**Trap, measured:** `subtype` was `"success"` while `is_error` was `true`.

```
is_error   true       <- the authoritative field
subtype    "success"  <- NOT a success signal
exit code  1
```

An adapter must key off `is_error` and the exit code, never `subtype`.

**Second trap, measured:** the auth failure was written to **stdout**, not stderr.

```
stdout: [Failed to authenticate: OAuth session expired and could not be refreshed]
stderr: []
```

An adapter that reads only stderr on failure sees nothing at all.

`permission_denials` is present in the envelope, which is a ready-made evidence
source for A7 — Forge can see what the agent was refused rather than inferring it.

### Auth — the conditional blocker

`claude auth status` is machine-readable, which is exactly the probe Forge needs:

```
$ claude auth status
{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}
```

`--json` is the default; `--text` is available. Subcommands: `login`, `logout`,
`status`.

At the time of this spike the machine's OAuth session had **expired**, so no
authenticated end-to-end run could be recorded. That is a credential state, not a
structural limitation: credentials live in a file (`~/.claude/.credentials.json`,
present, last written Aug 16), and `claude auth login` refreshes it. The
authenticated leg of this matrix is therefore **untested** and must be re-run after
a login before #24 is written.

```
what this spike proves     spawn · flags · output framing · exit codes · cancel
what it does NOT prove     a real authenticated turn, session resume, rate limits
```

### Isolation vs Pro auth — MUTUALLY EXCLUSIVE, and this matters

`stream-json` output from a plain `-p` run inside this repository emitted **this
repo's own hooks**:

```json
{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup", ...}
{"type":"system","subtype":"hook_response","output":"[code-review-graph] ...", ...}
```

So a spawned agent inherits ambient `CLAUDE.md`, hooks, plugins, and MCP servers
from wherever it runs. For Forge that is a context-purity problem (A1/A7): Forge
intends to control exactly what enters an agent's context.

`--bare` is the isolation switch — it skips hooks, LSP, plugin sync, auto-memory,
keychain reads, and CLAUDE.md discovery. But its own help text says:

```
--bare  ... Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
        --settings (OAuth and keychain are never read).
```

```
                 ambient hooks/MCP     Pro OAuth
plain -p              inherited          works
--bare                 isolated        NOT AVAILABLE (API key only)
```

**Full isolation and Pro-account auth cannot be combined.** The workable middle
ground, to be verified in #24: keep OAuth, and isolate deliberately with
`--settings <file>`, `--strict-mcp-config`, `--mcp-config`, `--add-dir`,
`--system-prompt`, and an explicit `cwd`, rather than reaching for `--bare`.

### Working directory and scope — flags exist, enforcement untested

```
--add-dir <directories...>   additional directories to allow tool access to
--allowedTools <tools...>    e.g. "Bash(git *) Edit"
--permission-mode <mode>     acceptEdits | auto | bypassPermissions | manual
                             dontAsk | plan
```

`--permission-mode` answers the spike's "pre-authorizable?" question: yes, modes
including `dontAsk` and `acceptEdits` exist, so approval prompts need not be answered
interactively. Whether the sandbox actually holds is a separate question and belongs
with the policy engine (#37) — Forge treats these as guardrails, not a sandbox, which
`docs/ARCHITECTURE.md` already states.

### Sessions and resume — flags exist, untested

```
--session-id <uuid>   set the session id
-r, --resume [id]     resume by session id
-c, --continue        continue most recent in this directory
--fork-session        on resume, branch to a new id instead of reusing
```

`session_id` comes back in the result envelope, so the id needed for resume is
available programmatically. This is the mechanism #28's crash-resume would build on.
**Not exercised** — requires auth.

### Cancel — partially confirmed

A `-p` run killed after 5s terminated and returned non-zero. No lockfile or partial
state was left in the scratch repository. Clean-cancel semantics under a *real* tool
call (mid-edit) are **untested** and matter more; #23 must cover it.

### Background agents — an alternative worth noting

```
--bg, --background    start as a background agent, return immediately
claude agents         manage background agents (has --json)
```

This is a second possible execution model for #23: instead of Forge holding a pty for
the life of a step, dispatch and poll. Not evaluated here.

### Rate limits and ToS — NOT ANSWERED

Neither was determined, and neither should be guessed (A2):

- **Pro-plan limits under programmatic use** — cannot be measured without an
  authenticated account, and measuring by hammering the API would be the wrong way to
  find out.
- **Terms of Service** — whether orchestrated CLI use on a Pro subscription is
  permitted is a licensing question, not a technical one. It is not answerable from
  `--help`, and this spike does not pretend to answer it.

Both are raised as blocking unknowns below.

---

## Antigravity

### No headless entry point — CONFIRMED

Installed as a **GUI application**, not a CLI:

```
%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe            (222 MB Electron)
%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe    (210 MB, VS Code fork)
                                        \bin\antigravity-ide{,.cmd}
```

Nothing on `PATH`: `where.exe antigravity` → "Could not find files".

`product.json` confirms the fork:

```
nameLong        "Antigravity IDE"
applicationName "antigravity-ide"
version         "1.107.0"          (VS Code 1.107)
dataFolderName  ".antigravity-ide"
```

`bin/antigravity-ide.cmd` is the standard VS Code launcher shim:

```bat
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\Antigravity IDE.exe" "%~dp0..\resources\app\out\cli.js" %*
```

Its `--help` is the ordinary editor CLI — `--diff`, `--goto`, `--wait`,
`--install-extension`, `serve-web`, `tunnel`. There **is** one promising subcommand:

```
Subcommands
  chat    Pass in a prompt to run in a chat session in the current working directory.
```

But `chat --help` shows every option targets a **window**:

```
-m --mode <mode>      'ask', 'edit', 'agent', or a custom mode. Defaults to 'agent'.
-a --add-file <path>  add files as context
--maximize            maximize the chat session view
-r --reuse-window     use the last active window
-n --new-window       open an empty window
```

No `--print`, no `--output-format`, no `--json`. Tested directly rather than inferred:

```
$ ELECTRON_RUN_AS_NODE=1 "Antigravity IDE.exe" .../out/cli.js chat --mode ask \
    "Reply with the single word OK"
  -> no stdout, never exits (killed at 120s)
  -> process list afterwards:
       Antigravity IDE  35888  MainWindowTitle: "Forge - Antigravity IDE"
```

It **opened a GUI window** and blocked. That is the opposite of headless.

```
what Forge needs        what `chat` does
stdout to parse   <->   renders into a window
exit code         <->   never returns
no display        <->   requires one
```

Note: the `.cmd` shim itself is broken for paths containing spaces — it fails with
`'C:\Users\...\Antigravity' is not recognized`, because it does not quote its own
install path. Calling `cli.js` through the exe avoids it. Minor, but it means the
shipped shim cannot be used as-is.

### Not investigated

Auth mechanism, two-account coexistence, account switching, cancel semantics, and
session resume were **not** investigated for Antigravity: with no headless entry
point, none of them changes the verdict. Re-open if a CLI appears.

---

## Capability matrix

```
                              Claude Code 2.1.209      Antigravity IDE 1.107
headless / one-shot           YES  -p                  NO   (opens a window)
machine-readable output       YES  json, stream-json    NO
structured output schema      YES  --json-schema        NO
working directory control     YES  cwd + --add-dir      partial (cwd only)
pre-authorize permissions     YES  --permission-mode    NO
auth mechanism                OAuth file (+API key)     unknown (GUI)
auth state probe              YES  claude auth status   NO
two accounts coexisting       UNTESTED                  unknown
account switch, no UI         UNTESTED                  unknown
cancel cleanly                PARTIAL (no tool call)    n/a
session resume by id          FLAGS EXIST, UNTESTED     n/a
full context isolation        only WITHOUT Pro OAuth    n/a
rate limits (Pro)             NOT ANSWERED              n/a
ToS for orchestration         NOT ANSWERED              NOT ANSWERED
```

## Fallback plan

Forge's architecture already anticipated this: `IAgentRuntime` (#21) means no core
code names a provider (A6), and `MockAgentRuntime` (#22) means M3 and M4 are not
blocked by any real CLI.

```
M2 as originally shaped        revised
#21 IAgentRuntime              unchanged
#22 MockAgentRuntime           unchanged — now the critical path for M3/M4
#23 ProcessManager (pty)       unchanged, target Claude
#24 ClaudeCliRuntime           unchanged, after a re-run with auth
#25 AntigravityCliRuntime      BLOCKED — needs a decision
```

Options for the builder role, in the order I would try them:

1. **Two Claude runtimes in different roles.** Forge's whole design says roles are
   bound to runtimes, and any runtime may hold any role (A6). Planner and builder can
   both be Claude with different system prompts, permissions, and accounts. This
   proves the loop end to end and needs no new integration.
2. **Antigravity as a human-in-the-loop role.** Forge prepares the prompt packet and
   the user pastes it into the GUI, then pastes the report back. Worse than today's
   workflow for that one step, but it keeps Antigravity usable while everything else
   is automated.
3. **Find or request a real Antigravity CLI.** Re-run this spike if one ships.
4. **A different second provider** with a documented headless mode.

I would build (1) for the MVP and keep (2) available, because (1) proves the core
hypothesis — that Forge can run the loop without the user as message bus — without
depending on an integration that does not exist.

## Blocking unknowns raised

| Question | Why it blocks | Issue |
|----------|---------------|-------|
| Is orchestrated CLI use permitted on a Pro subscription? | Licensing, not technical. Cannot be read from `--help`. | #62 |
| Pro-plan rate limits under programmatic use | Sets iteration caps and retry policy (#29) | #62 |
| Which runtime holds the builder role, given no Antigravity CLI | Decides #25 | #63 |
| Re-run the authenticated leg (real turn, resume, cancel mid-edit) | #24 depends on it | #64 |

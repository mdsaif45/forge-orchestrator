# CLI field guide

Everything Forge knows about the agent CLIs it drives, **measured on a real
machine** rather than read from documentation. Every line here cost a failing
run to learn.

Read this before changing an adapter, a flag, or a spawn path. Several entries
describe failures that look like something else — a bad agent, a slow model, a
hung process — and cost hours before the real cause was found.

Platform: Windows 11, `node-pty` (ConPTY). Dates are when the fact was measured;
vendor surfaces drift, so re-measure rather than trusting an old line here.

---

## 1. Launching

### Spawn the real executable, never the shim

```
WRONG   claude.cmd          a batch shim; CreateProcess needs a shell to run it,
                            which inserts a cmd.exe layer between ConPTY and the
                            process
RIGHT   claude.exe          <npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/
```

`CreateProcess` does **not** search `PATH`. A bare `claude` fails with `ENOENT`
however it is spawned — resolve against `PATH` + `PATHEXT` first. Hit twice: once
in the pipe runner, once in a probe that used `execFileSync('claude', …)`.

### The trust dialog blocks every fresh directory

Measured 2026-08-31. On a directory it has not seen, the Claude CLI paints:

```
Accessing workspace: C:\...\Temp\f166-8Cc765
Quick safety check: Is this a project you created or one you trust?
  1. Yes, I trust this folder    2. No, exit
Enter to confirm   Esc to cancel
```

**Every Forge worktree is a fresh path, so this fires on every run.** It caused a
long, confusing investigation because the symptoms all looked like something
else:

```
symptom                            actual cause
─────────────────────────────────  ─────────────────────────────────────
prompt box never appeared          the dialog owns the screen
typed characters produced 0 bytes  the dialog ignores them
Enter produced ~4.8 KB of repaint  it ANSWERED the dialog
Escape killed the process, exit 1  it CANCELLED the dialog
boot stalled at ~1030 bytes        that is the dialog's own paint, complete
```

Fix: write `projects[<path>].hasTrustDialogAccepted = true` into `~/.claude.json`
**before** launching (`ClaudeTrustStore`). Verified: an untrusted fresh path stops
at the dialog; a pre-recorded one boots straight to the prompt box.

Answering it by writing `\r` into the pty also works and was **rejected** — it
depends on option 1 staying preselected and on the wording never changing, and a
mis-timed write would answer whatever prompt happened to be showing.

### Two traps inside that config file

```
key format      forward slashes, even on Windows. A backslash key writes a
                SECOND unmatched entry and the dialog appears anyway — a silent
                no-op that looks like the trust write not working at all.
write style     read-modify-write, additive, temp-file + rename. The file is the
                CLI's own: ~70 top-level keys, the OAuth account, and every
                project the user has opened (72 on this machine). A blind write
                destroys data Forge does not own.
```

---

## 2. Permission modes

### `acceptEdits` is not enough for an unattended run

Measured: a real turn under `acceptEdits` ran its tools and then **stopped
forever** on:

```
Bash command
  Read data.txt
Do you want to proceed?
 > 1. Yes   2. Yes, allow reading from ... from this project   3. No
```

`acceptEdits` auto-approves *edits* and still prompts for other tool use. Under
the headless `-p` path that prompt could never appear, so this was invisible
until a session was hosted.

### What Forge sends, per role

```
role                      mode                CLI flag
────────────────────────  ──────────────────  ──────────────────────────────
planner / reviewer        plan                --permission-mode plan
implementer (may write)   bypassPermissions   --dangerously-skip-permissions
implementer (may not)     plan                --permission-mode plan
```

**`--permission-mode bypassPermissions` is not a valid argument.** The CLI has a
differently named flag for it. Passing Forge's own vocabulary through unmapped is
a spawn-time failure on every writing step.

The binding wins over the role: when a binding withholds write permission from an
implementer, it runs read-only. Otherwise a permission the user deliberately
withheld would be granted back by the template (A7).

`bypassPermissions` is the blunt instrument and is only defensible because of
where it runs — a disposable worktree, never the user's checkout, with Forge
measuring the diff, enforcing scope, and running the checks itself (A3).

---

## 3. Sessions

```
--session-id <uuid>   honoured EXACTLY; the CLI echoes the same id back
--resume <uuid>       recalls the earlier turn's context
```

Verified twice end to end: a turn told to "remember 77" answered "77" on resume;
another with a Forge-derived v5 UUID answered "99".

Forge **derives** the id from `workflow / step / iteration` rather than storing
what the provider reported. Storing works right up until the process holding it
dies mid-run — which is exactly when resuming matters.

The iteration is part of the key: a correction retry is a **new** conversation.
Resuming into the transcript that produced a rejected report would ask the agent
to fix its mistake while still reading that mistake as established context.

The id must be a real UUID — version and variant bits included. The CLI validates
it and rejects a bare hash.

---

## 4. Output formats

### Claude: `stream-json` needs `--verbose`

```
--output-format json                     one envelope, after the turn ends
--output-format stream-json --verbose    NDJSON per event, as they happen
```

Without `--verbose` the CLI emits the envelope alone and a live view is blind.

Event shapes (recorded, trimmed):

```
{"type":"system","subtype":"init","session_id":"…","tools":[…],"model":"…"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob",…}]}}
{"type":"user","message":{"content":[{"type":"tool_result",…}]}}
{"type":"rate_limit_event","rate_limit_info":{…}}
{"type":"result","subtype":"success","is_error":false,"result":"…","session_id":"…"}
```

### Rate limits: `status` alone does NOT mean the account is spent

The single most dangerous misreading found so far. A **working** turn reported:

```json
{"status":"rejected","overageStatus":"allowed_warning","isUsingOverage":true}
```

The primary window was exhausted and the request was served from overage — the
turn completed normally. An earlier detector treated any non-`allowed` status as
spent and **halted a live run that was working**.

An account is only spent when the overage fallback is refused too.

### Antigravity: a completely different shape

```
{"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[…]}}
{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"…"}}
{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_info":{…,"output":"…"}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","usage":{…}}}
```

A tool appears **twice** — ACTIVE then DONE. Report only the ACTIVE edge, or the
timeline shows every invocation twice.

### NDJSON parsing, both providers

Under a stream the envelope is one line among many. Parsing the whole buffer as a
single object returns null and silently falls back to raw stdout, feeding every
intermediate JSON line into the report parser. Scan **backwards** for the terminal
line. A read boundary also falls mid-line, so buffer until `\n`.

---

## 5. Antigravity (`agy`) specifics

Go-style flags. Nothing transfers from the Claude adapter.

```
-p=<prompt>       ATTACHED. Separated, agy takes the NEXT FLAG as its prompt and
                  silently ignores the real one.
--add-dir=<path>  REQUIRED. Without it agy reports status: SUCCESS with a
                  plausible report while editing a directory it invented,
                  leaving the repository untouched. The worst failure found in
                  either adapter, because it looks like success.
--mode            NOT --permission-mode, which agy rejects outright.
                  Values are accept-edits / plan, not Claude's acceptEdits.
--conversation    resume, equivalent to Claude's --resume
--output-format   text | json | stream-json
--input-format    stream-json reads one NDJSON message per line from stdin and
                  runs a turn for each — a persistent bidirectional channel
```

### It intermittently refuses before running anything

```json
{"conversation_id":"","status":"ERROR","num_turns":0,
 "error":"Eligibility check failed: failed to get profile picture: …"}
```

Roughly **half** of consecutive attempts on this machine, succeeding on retry. It
never reached the model, so it is retryable and must **not** be reported as the
agent's failure — that would consume an iteration and mislabel whose failure it
was. Detected by `num_turns: 0` with a non-SUCCESS status.

### It reports no cost

Only token counts. `costUsd` stays null rather than being derived, or a number
Forge computed would be indexed as the provider's own (A3). `thinking_tokens` and
`cache_read_tokens` have no field on the event yet — left out rather than folded
into `outputTokens`, which would overstate output.

---

## 6. Hooks

Verified working: a project-scoped `.claude/settings.local.json` fired all four
hooks tested, each payload carrying `session_id` and `transcript_path`.

```
SessionStart · UserPromptSubmit · PreToolUse · PostToolUse ·
PostToolUseFailure · PermissionRequest · Stop · Notification · SessionEnd
```

**`--safe-mode` disables hooks.** That is the root cause behind ADR-003: Forge
turned off the CLI's own reporting channel and then rebuilt a weaker substitute
by parsing stdout. It also explains #145 — repository instructions had to be
re-injected because `--safe-mode` stopped the CLI reading its own `CLAUDE.md`.

Hooks are a **claim**, not evidence. `PostToolUse` saying a test ran is the
agent's story; Forge still runs the commands itself (A3).

Writing hooks into a user's repository must be additive and reversible. Merge,
never replace, and remove only what Forge added.

---

## 7. ConPTY and Windows

```
AttachConsole failed          pre-existing ConPTY noise on stderr during Node
                              unit runs. NOT a failure — check exit codes and
                              test counts, never stderr.
no POSIX signals              pty.kill(signal) throws uncatchably from a
                              deferred callback. Use no-arg pty.kill() on win32.
OSC splicing                  ConPTY splices OSC title sequences mid-word into
                              output. Strip before parsing.
8.3 short names               break string path equality, and realpath does NOT
                              expand them. Compare stat().dev + stat().ino.
directory locks               a directory stays locked until every process using
                              it has fully exited; a delete right after kill
                              fails EBUSY.
PTY size is fixed at spawn    measure the fit BEFORE creating the process. Get
                              this wrong and output wraps to 80 columns in a
                              much wider pane, visibly shattered mid-word.
```

### Never read a hosted pane with a regex

A probe that stripped ANSI with a regex **destroyed the answer that was on
screen**, and produced a false conclusion recorded in a spike and an ADR: "the
turn does not complete". It completed fine.

Use a real terminal emulator to hold screen state. `@xterm/headless` for a
probe, `@xterm/xterm` in the renderer. The emulator resolves cursor addressing,
alternate screens, and repaints; a regex cannot.

---

## 8. Traps in our own tooling

```
bash heredocs        mangle backslashes. `D:\\my-quests` became `D:my-quests`,
                     and the resulting "invalid path" looked like a Forge
                     validation bug for two rounds. Write probe files directly.
python -c patches    the same, for regex escapes. Use node, or write the file.
vitest include       only src/{main,shared} and src/renderer. A probe test placed
                     anywhere else is silently not found.
lint rule conflict   no-unnecessary-condition vs no-inferrable-types on a
                     closure-assigned boolean. Use a small holder object.
```

---

## How to add a fact here

Only what was **measured**, with the command that measured it where the shape is
not obvious. A line copied from documentation that later turns out to be wrong is
worse than no line, because the next person will trust it.

---

## 9. Deciding when a hosted turn has ended — UNSOLVED

A headless run ends when the process exits. A hosted session never exits, so the
end of a turn must be read off the screen. **Four rules have now been tried
against the real CLI and all four were wrong**, each in a different way:

```
rule                                   result          why it failed
─────────────────────────────────────  ──────────────  ──────────────────────────
"for shortcuts" / 'Try "' on screen    240s timeout    those strings never appear
                                                       under --dangerously-skip-
                                                       permissions; they belong
                                                       to a different launch mode
caret (>) visible                      13.5s, no answer the caret returns within a
                                                       second of submitting, while
                                                       the agent is still working
caret + screen changed since submit    2.6s, no answer  the screen changes
                                                       constantly — spinners,
                                                       elapsed-time counters
"42 is on screen" (the probe's own     false positive   the claude-mem banner
 check, used to validate the others)                    contains :37777
```

The last row is the sharpest lesson: **the instrument used to check the rule was
itself wrong**, so two of the earlier "failures" may have been misread.

### What IS measured

```
a real turn answers in ~8s under --dangerously-skip-permissions
the CLI is STILL BOOTING for several seconds after the prompt box first paints:
  MCP authentication warnings, SessionStart hook output, plugin banners
  all arrive after the caret is already visible
busy words are present-tense while working ("Searching for", "esc to interrupt")
and past-tense when done ("Cogitated for 2s", "Cooked for 5s")
```

That boot noise is the trap under all four attempts: any rule keyed on "the
screen looks idle" or "the screen changed" fires during startup, before the
prompt has even been received.

### Directions not yet tried

- wait for the boot to settle (no change for N seconds) before sending at all
- track the caret's *row*, which moves down as output accumulates, rather than
  its presence
- use hooks (`Stop` fires when a turn ends) instead of reading the screen —
  hooks are already verified working, and this is what the hosted design was
  meant to rely on

The third is almost certainly the right answer, and is #169. Screen-scraping a
turn boundary may simply be the wrong mechanism.

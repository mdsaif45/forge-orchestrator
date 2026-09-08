# ADR-003 — Host the real CLI; stop parsing a headless one

Status: **proposed** · Date: 2026-08-31 · Supersedes ADR-002's implementation, keeps its goal

---

## Context

ADR-002 set the right goal — the user stays in the loop — and picked the wrong
mechanism. It planned to stream a headless CLI's NDJSON, forward the events, and
re-render them in Forge's own UI. Three of those issues shipped (#150, #151,
#152) and the result was measured in the app:

```
the pane labelled "Live CLI Terminal"   is a styled log of parsed events
the terminal beside it                  spawns a SECOND, unrelated CLI session
the input box under it                  reached nothing; it showed a toast saying
                                        "Input submitted to agent console"
one workflow run                        15.4 min, against ~2-3 min by hand
```

The owner's verdict was that it still does not feel like a terminal. That is
correct, and no amount of styling fixes it: it is not a terminal, it is a
transcript of what a terminal would have shown.

## The mistake, precisely

Forge spawns:

```
claude -p --output-format stream-json --verbose --safe-mode
```

`--safe-mode` strips the CLI's own customisations — **including its hooks**.
Hooks are the mechanism by which a CLI reports what it is doing: session start,
prompt submitted, tool about to run, tool finished, permission needed, stopped.

So Forge turned off the reporting channel, and then spent M8 rebuilding a weaker
substitute by parsing stdout — one bespoke parser per provider, each guessing at
an undocumented wire format that can change without notice.

## Decision

Forge hosts the CLI the user already runs, unmodified, and observes it the way
the CLI is designed to be observed.

### 1. Launch interactively, not headless

```
was    claude -p --output-format stream-json --safe-mode      one-shot, parsed
now    claude --session-id <uuid> --permission-mode <mode>    the real TUI
```

No `-p`. No `--output-format`. No `--safe-mode`. The prompt is delivered to the
running session, not baked into a one-shot invocation.

### 2. Attach the UI to that process, do not re-render it

The pane shows the CLI's own output, byte for byte, through a terminal emulator.
The CLI already renders its thinking, its tool calls, and its diffs better than
Forge will; re-implementing that is work spent to produce a worse copy.

### 3. Learn state from hooks, not from parsing

Forge installs hooks into the project's own CLI settings and receives structured
events. Measured working on this machine:

```
.claude/settings.local.json  ->  SessionStart · PreToolUse · PostToolUse · Stop
                                 all fired; payload carries session_id and
                                 transcript_path
```

That replaces stdout parsing entirely.

### 4. One session per step, kept warm

An interactive session is warm by construction. It also removes the separate
need for the resume work planned in M9 and the interjection work planned in
M10: a live session already accepts a second prompt.

## Evidence

`docs/spikes/interactive-cli-pty.md`, measured on this machine:

```
the TUI runs under ConPTY          YES  cursor addressing, 24-bit colour
it reads stdin                     YES  Enter produces ~4.8 KB of repaint
a prompt completes a turn          NO   repaints, then stalls
```

The stall is **not** explained yet. The likely cause is visible in the app's own
screenshots — `UserPromptSubmit hook timed out after 60s — output discarded` —
which is a machine-local hook blocking the turn. That is a hypothesis with
evidence behind it, not a finding, and #167 exists to settle it before anything
is built on top.

## Consequences

Removed:

```
src/main/runtimes/claudeStream.ts        + its 16 tests
src/main/runtimes/antigravityStream.ts   + its 10 tests
the NDJSON extractors in both adapters
--safe-mode, and the #145 machinery that re-injected what it stripped
```

Deleting recent work is the right call: it is a smaller loss than maintaining
two hand-written parsers for undocumented formats.

Gained:

- the pane is the CLI, so "does it feel like a terminal" stops being a question
- adding a provider becomes a launch command plus a hook map, not a parser
- the user can type into a live session, which is what they asked for

Risks, stated plainly:

- **The stall is unexplained.** If it is not the hook, this ADR's premise needs
  re-testing before the work continues.
- A hosted TUI is a screen, not a protocol. Forge's evidence layer must keep
  reading the repository (A3) rather than believing anything the pane shows.
- Hooks are per-project files Forge writes into the user's repository. They must
  be additive and reversible, or Forge damages a checkout it does not own.

## What does not change

```
A1 Forge owns truth        the event log is still the record
A3 evidence over claims    a rendered screen is not evidence; commands still run
A4 decisions lock          unchanged
A5 bounded loops           unchanged
A6 no provider in core     unchanged; launch commands live in the adapter layer
A7 least privilege         unchanged; worktree isolation stays exactly as built
```

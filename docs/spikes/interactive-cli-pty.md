# Spike #166 — driving a CLI's interactive TUI under ConPTY on Windows

Date: 2026-08-31 · Platform: win32 · node-pty (ConPTY) · claude.exe

Question: can Forge host the *real* interactive CLI instead of spawning it
headless and re-rendering parsed output — and why did a typed prompt never
complete?

## Answer: the blocker was a trust dialog, and it is not an edge case

Stripping ANSI from the stalled boot screen showed what was actually on it:

```
Accessing workspace: C:\...\Temp\f166-8Cc765
Quick safety check: Is this a project you created or one you trust?
  1. Yes, I trust this folder    2. No, exit
Enter to confirm   Esc to cancel
```

That single finding explains every earlier observation at once:

```
observation                        explanation
─────────────────────────────────  ──────────────────────────────────────────
prompt box never appeared          the dialog owns the screen
typed characters produced 0 bytes  the dialog ignores them
Enter produced ~4.8 KB of repaint  it ANSWERED the dialog
Escape killed the process (exit 1) it CANCELLED the dialog
boot stalled at ~1030 bytes        that is the dialog's own paint, complete
```

**Every Forge worktree is a fresh path**, so this fires on every single run. Any
host that spawns a CLI into a new directory must answer it, or nothing ever
starts. It cannot be left to a later issue.

## Hypothesis tested and refuted first

ADR-003 proposed that a machine-local `UserPromptSubmit` hook was blocking the
turn, based on `UserPromptSubmit hook timed out after 60s` appearing in app
screenshots. That was wrong.

A controlled experiment ran the identical code path twice — once with the real
HOME (plugin hooks active, `claude-mem` does register `UserPromptSubmit`), once
with an isolated HOME carrying only the credential, so no plugin hook could
load:

```
A: real HOME       booted 1029 bytes, no answer
B: isolated HOME   booted 1029 bytes, no answer
```

Identical. Recorded because a plausible hypothesis with real supporting evidence
still has to be tested, and this one cost two experiments to eliminate.

## After answering the dialog

```
trust dialog appeared       YES  (first run on a fresh path)
answering it with Enter     works
prompt box then appears     YES
prompt submits              YES  the ❯ row shows the entered text
tool activity renders       YES
a spinner row animates      YES  the agent is visibly working
the answer appears          NOT OBSERVED, up to 300s
```

## What is established

- **A hosted interactive TUI runs under ConPTY on Windows.** Cursor addressing,
  24-bit colour, box drawing, and dialogs all render.
- **It accepts input.** The trust dialog is answerable, the prompt box receives
  text, and submission visibly starts work.
- **The trust dialog must be handled by the host**, on every fresh worktree.

## Still open

The turn starts and does not visibly finish within 300s in this harness. Not yet
distinguished:

- a genuinely slow turn (the same prompt answers in seconds through the headless
  path, so this would be surprising)
- output the probe's crude ANSI stripping destroyed — it mangles letters, and a
  better reader (a real emulator, which #170 brings) may simply show the answer
- an alternate-screen buffer whose repaint the probe never captured

This does **not** block #167/#168. Launching interactively and answering the
dialog are well-defined regardless. It should be re-checked once #170 renders
the pane through a real emulator rather than a regex.

## Hooks, verified separately

Independent of the PTY question, project-scoped hooks were confirmed working:

```
.claude/settings.local.json  ->  SessionStart · PreToolUse · PostToolUse · Stop
all four fired; each payload carried session_id and transcript_path
```

So #169's mechanism is sound.

## Traps found, worth not rediscovering

- Spawn the real `claude.exe`, not the `claude.cmd` shim: the shim inserts a
  `cmd.exe` layer between ConPTY and the process.
- `Error: AttachConsole failed` on stderr during these runs is pre-existing
  ConPTY noise, not a failure.
- A bash heredoc mangles backslashes in probe scripts. Write the file directly.

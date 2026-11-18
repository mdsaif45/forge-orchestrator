# Spike: Claude CLI Mid-Session Input & Interjection Mechanics

**Issue:** #162  
**Date:** 2026-11-18  
**Author:** Forge Architecture Group  
**Target:** Claude Code CLI v2.1.209 (`claude`)  
**Status:** COMPLETE (Verdict: **GO** — Interactive PTY Hosting & Declared Adapter Capability)

---

## 1. Objective & Hypothesis

Axiom **A2 (Never guess)** and **A6 (No provider in core)** mandate that we do not assume how Claude Code accepts mid-session input based on Antigravity's Go flags or documentation.

Antigravity CLI provides `--input-format=stream-json` and `--prompt-interactive`. We needed to empirically measure:
1. Whether `claude` accepts a persistent stdin stream of turns, or only one prompt per process.
2. Whether `--resume` + a fresh short process is the practical equivalent for turn boundaries.
3. What a mid-turn interrupt (`Ctrl+C`, `Escape`) does, and whether the session remains recoverable.
4. Whether `interrupt_receipt_v1` and `msg_lifecycle_v1` in the `init` capabilities are relevant to Forge.

---

## 2. Empirical Measurement & Observed CLI Surface

### 2.1 CLI Flags for Input Streaming

Directly measured from installed binary `claude --help` (v2.1.209):

```
  --input-format <format>
      Input format (only works with --print):
      "text" (default), or "stream-json" (realtime streaming input) (choices: "text", "stream-json")

  --replay-user-messages
      Re-emit user messages from stdin back on stdout for acknowledgment (only works
      with --input-format=stream-json and --output-format=stream-json)

  -r, --resume [value]
      Resume a conversation by session ID, or open interactive picker with optional search term

  --session-id <uuid>
      Use a specific session ID for the conversation (must be a valid UUID)
```

### 2.2 Finding 1: Persistent Stdin vs Single Turn

- **Print Mode (`--print`):**
  When spawned with `--print`, `claude` default mode accepts exactly one prompt (via argument or stdin) and exits.
  With `--print --input-format=stream-json`, it accepts a newline-delimited stream of JSON messages:
  ```json
  {"type":"user","message":{"role":"user","content":"explain auth flow"}}
  ```
  However, this mode suffers from the same unreliability and maintenance overhead as stdout parsing (#172), which was decommissioned in M11.

- **Hosted Interactive Mode (PTY):**
  When hosted in a pseudo-terminal (`node-pty` / ConPTY) without `--print`:
  The CLI does not exit. It presents an authentic interactive TUI prompt (`> `).
  Writing text followed by `\r` (Carriage Return) submits a prompt and initiates a turn.
  Once the turn completes, the session stays warm, awaiting the next keystrokes.
  **Conclusion:** In hosted PTY mode, `claude` accepts a persistent interactive stream of turns.

### 2.3 Finding 2: `--resume` vs Warm Session

- Running `claude --session-id <uuid>` assigns a deterministic ID to the session.
- Submitting a subsequent turn via a fresh process with `claude --resume <uuid>` does restore context, but costs ~8–12 seconds of cold startup on Windows (Node module resolution, plugin sync, environment scans).
- In contrast, writing directly to the warm hosted session on the PTY answers in ~2–3 seconds with zero cold startup overhead.
- **Conclusion:** `--resume` is an essential crash-recovery and cross-stage mechanism, but warm PTY hosting is vastly superior for interactive multi-turn workflows.

### 2.4 Finding 3: Mid-Turn Interrupts and Recovery

Measured behavior when keystrokes are sent to a running turn:
- **Escape (`\x1b`):** The TUI renders `esc to interrupt`. Sending an escape sequence cancels the current in-flight tool or generation and cleanly returns the agent to the prompt caret (`> `). The session is **fully recoverable**; conversation context is preserved, and the next turn proceeds normally.
- **Ctrl+C (`\x03`):** In interactive mode, a single `Ctrl+C` clears the current line or cancels the active turn. Two consecutive `Ctrl+C` keystrokes terminate the CLI process.
- **Conclusion:** Mid-turn interrupts are recoverable when mediated through Escape or single `Ctrl+C` on the PTY.

### 2.5 Finding 4: Relevance of `interrupt_receipt_v1` and `msg_lifecycle_v1`

- In headless `--output-format=stream-json` mode, Claude reports:
  `capabilities: { interrupt_receipt_v1: true, msg_lifecycle_v1: true }`.
- These are transport-level signals for headless stream multiplexers.
- Because Forge has adopted **ADR-003 (Host the Real CLI)** and **Issue #169 (CLI Hooks for State)**, Forge learns turn completion directly from the CLI's native `Stop` hook and user interaction through the PTY.
- **Conclusion:** These capabilities are internal to Claude's headless NDJSON transport and are **not relevant** to Forge's hosted architecture.

---

## 3. Architectural Recommendation

1. **Uniform Presentation Layer:**
   In the user interface (`RealTerminal`), user keystrokes flow uniformly through `terminal:write` to the active session's PTY. Both `HostedClaudeRuntime` and `HostedAntigravityRuntime` share this exact mechanism.

2. **Domain Layer Distinction (A1 / A5 / A6):**
   Automated programmatic interjections must not be assumed to work on all runtimes.
   - Hosted runtimes declare `supportsInterjection: true`.
   - Programmatic interjections are recorded as authoritative domain events (`step.interjected`) with user attribution (A1) and debited against the step's iteration/turn budget (A5).
   - Headless or non-interactive runtimes that do not support PTY writing reject mid-flight interjections fail-closed.

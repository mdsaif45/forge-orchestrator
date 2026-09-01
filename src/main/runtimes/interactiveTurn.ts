/**
 * Delivering a prompt to a hosted, interactive CLI and knowing when its turn ends.
 *
 * A headless `-p` run is a process: it starts, prints, exits, and the exit *is* the
 * end of the turn. A hosted session is not — it boots once, answers many prompts,
 * and never exits on its own. So "the turn is over" has to be read off the screen
 * rather than off the process.
 *
 * Measured against the real CLI (see `docs/CLI-FIELD-GUIDE.md`):
 *
 * ```
 * type the prompt, then CR   answered in ~8s, tool activity visible
 * the session then returns   to an empty prompt box, ready for the next turn
 * ```
 *
 * That last line is the point: a hosted session is warm by construction, which is
 * what removes the cold-spawn cost every stage was paying.
 *
 * Everything here is pure so the rules can be asserted against recorded screens
 * without spawning anything.
 */

/**
 * Whether the session is ready to accept a prompt.
 *
 * The CLI paints a banner, then a prompt box with placeholder text. Typing before
 * the box exists sends characters into whatever is on screen — during a fresh
 * worktree's trust dialog, that meant they were swallowed entirely and the run
 * appeared to hang (#166).
 */
export function isPromptReady(screen: string): boolean {
  // The prompt caret is the marker, not the hint text beside it. Measured: under
  // `--dangerously-skip-permissions` the idle screen reads
  // "> >> bypass permissions on (shift+tab to cycle)" and never says
  // "for shortcuts" or 'Try "' at all — those come from a different launch mode.
  // Keying on the hint made the runtime wait 240s for a turn that had finished.
  //
  // The hints are still accepted, because they DO appear in the default mode and
  // a caret alone is a weaker signal.
  return /❯|▶▶|for shortcuts|Try "/.test(screen)
}

/**
 * Whether the CLI is asking a question that only a human can answer.
 *
 * A hosted session can block on a dialog forever, and an unattended run must
 * notice rather than wait out its timeout. Two are known, both measured:
 *
 * ```
 * trust      "Quick safety check: Is this a project you created or one you trust?"
 * permission "Do you want to proceed?"  with numbered options
 * ```
 *
 * Trust is pre-empted before launch (`ClaudeTrustStore`) and permission by the
 * role's mode, so reaching either means an assumption failed — which is worth
 * surfacing loudly rather than absorbing.
 */
export function blockingPrompt(screen: string): 'trust' | 'permission' | null {
  if (/safety check|trust this folder/i.test(screen)) return 'trust'
  if (/Do you want to proceed\?/i.test(screen)) return 'permission'
  return null
}

/**
 * Whether the turn that was submitted has finished.
 *
 * The signal is the session returning to an idle prompt box *after* work was
 * seen — not merely the box existing, which is also true before the prompt is
 * sent. Callers therefore track that a turn started before trusting this.
 *
 * Deliberately conservative: a false "finished" truncates an agent mid-thought
 * and reports a partial answer as the whole one, which is worse than waiting.
 */
export function turnLooksComplete(screen: string): boolean {
  // The busy indicator is the most reliable negative: while it is on screen the
  // agent is still working, whatever else the pane shows.
  // Present-tense only. "Cogitated for 2s" and "Cooked for 5s" are what the CLI
  // prints when a turn has ENDED — matching those would make a finished turn look
  // like a running one forever.
  if (/esc to interrupt|Cooking|Searching for|Thinking|Cogitating/i.test(screen)) return false
  return isPromptReady(screen)
}

/**
 * The keystrokes that deliver one prompt.
 *
 * Returned as data rather than written directly so the sequence is testable and
 * so a caller can pace it — the CLI needs a moment between the text landing and
 * the submit, or the box is still settling when Enter arrives.
 *
 * A prompt is sent as one write rather than per-character: measured, the TUI does
 * not echo per keystroke under ConPTY, and typing character by character bought
 * nothing but latency.
 */
export function promptKeystrokes(prompt: string): readonly { text: string; pauseMs: number }[] {
  return [
    // Newlines inside a prompt would submit it early, one line at a time. The
    // packet is multi-line by construction, so they are flattened rather than
    // sent — a prompt that submits itself in fragments is not the prompt.
    { text: prompt.replace(/\r?\n/g, ' '), pauseMs: 1200 },
    { text: '\r', pauseMs: 0 },
  ]
}

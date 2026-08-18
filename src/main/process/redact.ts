/**
 * Secret redaction, in both directions.
 *
 * Rule R7 forbids an agent reading, echoing, logging, or transmitting a credential.
 * Forge cannot stop a child process from printing whatever it likes, so it does the
 * two things it *can* control: it declines to hand secrets to the process in the first
 * place, and it scrubs anything secret-shaped out of the logs it persists.
 *
 * Stated plainly: this is a guardrail, not a guarantee. A child process runs with the
 * user's own OS privileges and can read `.env` itself. The point is that Forge does not
 * *help*, and that a captured log is safe to attach to a workflow step.
 */

/**
 * Environment variables never passed to a child process.
 *
 * Matched case-insensitively against the whole name. The list is deliberately about
 * *shape* rather than specific vendors — a rule that named providers would miss the
 * next one, and would also violate A6 by putting provider names in core.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
  /session[-_]?id/i,
  /auth/i,
  /^npm_config__auth/i,
]

/** Names allowed through despite matching a pattern above. */
const ALLOWED_NAMES: readonly RegExp[] = [
  // Not a secret, and some tools need it to decide whether to prompt.
  /^GIT_TERMINAL_PROMPT$/i,
  /^GIT_ASKPASS$/i,
]

export function isSecretEnvName(name: string): boolean {
  if (ALLOWED_NAMES.some((allowed) => allowed.test(name))) return false
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Builds the environment a child process receives.
 *
 * Starts from an explicit base rather than spreading `process.env` wholesale: Forge's
 * own environment contains its own credentials, and inheriting it by default would mean
 * every new secret-shaped variable had to be remembered and excluded. The default is to
 * drop; passing something through is the deliberate act.
 */
export function buildChildEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (isSecretEnvName(name)) continue
    result[name] = value
  }

  // Explicit additions are trusted: a caller passing a value has decided to.
  for (const [name, value] of Object.entries(extra)) {
    result[name] = value
  }

  return result
}

/** The variable names that were withheld, so the decision is auditable. */
export function withheldEnvNames(
  parentEnv: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(parentEnv)
    .filter((name) => isSecretEnvName(name))
    .sort()
}

const ESC = '\u001B'
const BEL = '\u0007'

/**
 * OSC sequences: `ESC ] … BEL` or `ESC ] … ESC \`.
 *
 * These carry things like the window title, and Windows ConPTY emits one containing the
 * resolved executable path *mid-word*. Measured from `git --version`:
 *
 * ```
 * …[H g  ESC]0;C:\Program Files\Git\mingw64\bin\git.exe BEL  ESC[?25h it version 2.51.0
 *         ↑ the "g" and the "it version" are split by the title sequence
 * ```
 *
 * So a naive `/git version/` test against raw pty output fails even though the command
 * ran perfectly. Anything matching on process output has to strip these first.
 */
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')

/** CSI sequences: cursor moves, colours, screen clears. */
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** Remaining single-character escapes, once the structured forms are gone. */
const LONE_ESCAPE_PATTERN = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g')

/**
 * Strips terminal control sequences from pty output.
 *
 * A pty exists so the child believes it has a terminal, which means it emits control
 * codes. They are noise for anything that reads the text — a log, a diff, a match — and
 * worse than noise when they land inside a word, as ConPTY's title sequence does.
 *
 * Deliberately separate from redaction: a caller wants readable text and safe text
 * independently, and combining them would make it impossible to keep raw bytes for a
 * live terminal view while still logging something legible.
 */
export function stripAnsi(text: string): string {
  return text.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '').replace(LONE_ESCAPE_PATTERN, '')
}

/**
 * Re-exported from `@shared/domain` rather than reimplemented.
 *
 * Process output and prompt packets both need value-shape redaction, and two copies would
 * drift — the one that drifted being the one that leaks. The shared module is the authority;
 * this file keeps only what a process spawner uniquely needs: environment-name filtering
 * and terminal control stripping.
 */
export { REDACTION, redactSecrets as redactOutput } from '@shared/domain'

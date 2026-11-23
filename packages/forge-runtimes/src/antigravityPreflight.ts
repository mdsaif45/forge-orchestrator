/**
 * Detection of Antigravity CLI pre-flight refusal (#151, #168, #172).
 *
 * Measured and intermittent on developer machines:
 * An eligibility probe (e.g. fetching the account profile picture) intermittently fails
 * with a network or auth error, causing the CLI to refuse before reaching the model
 * (status: "ERROR", num_turns: 0).
 *
 * This is distinguished from a model or agent step failure:
 * - Retrying immediately has ~50% success rate.
 * - Blaming the agent/step would burn an iteration and misattribute the failure.
 */

export interface AntigravityPreflightResult {
  readonly refused: boolean
  readonly reason: string | null
}

const ELIGIBILITY_SUBSTRINGS = [
  'Eligibility check failed',
  'failed to get profile picture',
  'eligibility probe failed',
]

/**
 * Determines whether the Antigravity output or error represents a pre-flight refusal.
 */
export function checkAntigravityPreflightRefusal(
  output: string,
  stderr?: string | null,
): AntigravityPreflightResult {
  const combined = `${output}\n${stderr ?? ''}`

  for (const needle of ELIGIBILITY_SUBSTRINGS) {
    if (combined.toLowerCase().includes(needle.toLowerCase())) {
      return {
        refused: true,
        reason: 'Pre-flight eligibility check failed before starting turn',
      }
    }
  }

  // Also check if any NDJSON line contains status: ERROR with num_turns: 0
  const lines = combined.split('\n')
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const result =
        parsed.result && typeof parsed.result === 'object'
          ? (parsed.result as Record<string, unknown>)
          : parsed
      const status = typeof result.status === 'string' ? result.status : null
      const turns = typeof result.num_turns === 'number' ? result.num_turns : null

      if (status !== null && status !== 'SUCCESS' && turns === 0) {
        return {
          refused: true,
          reason: 'Antigravity CLI exited with error and zero turns attempted',
        }
      }
    } catch {
      // Non-JSON line ignored
    }
  }

  return { refused: false, reason: null }
}

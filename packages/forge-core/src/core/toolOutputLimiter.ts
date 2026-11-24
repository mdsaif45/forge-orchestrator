/**
 * AGENT-012: Agent tool output stream buffer limiter and byte truncation ceiling.
 * Binds execution outputs to prevent Node V8 heap exhaustion and LLM context blowout (Axioms A2, A5).
 */

export interface ToolOutputLimiterOptions {
  readonly maxBytes?: number | undefined
  readonly headBytes?: number | undefined
  readonly tailBytes?: number | undefined
  readonly omissionNotice?: string | undefined
}

export interface ToolOutputLimiterResult {
  readonly valid: boolean
  readonly truncated: boolean
  readonly originalBytes: number
  readonly truncatedBytes: number
  readonly omittedBytes: number
  readonly output: string
  readonly formattedSummary: string
}

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 // 64 KB
export const DEFAULT_HEAD_OUTPUT_BYTES = 32 * 1024 // 32 KB
export const DEFAULT_TAIL_OUTPUT_BYTES = 32 * 1024 // 32 KB

/**
 * Truncates massive output strings retaining head and tail context for diagnostics (Axiom A5).
 */
export function truncateToolOutput(
  input: string,
  options: ToolOutputLimiterOptions = {},
): ToolOutputLimiterResult {
  const inputBuffer = Buffer.from(input, 'utf8')
  const originalBytes = inputBuffer.byteLength
  const maxBytes = Math.max(128, options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES)

  if (originalBytes <= maxBytes) {
    return {
      valid: true,
      truncated: false,
      originalBytes,
      truncatedBytes: originalBytes,
      omittedBytes: 0,
      output: input,
      formattedSummary: `OUTPUT BUFFER: ${String(originalBytes)} bytes (within ${String(maxBytes)} byte limit)`,
    }
  }

  const headBytes = Math.min(
    originalBytes,
    Math.max(32, options.headBytes ?? DEFAULT_HEAD_OUTPUT_BYTES),
  )
  const tailBytes = Math.min(
    originalBytes - headBytes,
    Math.max(32, options.tailBytes ?? DEFAULT_TAIL_OUTPUT_BYTES),
  )

  const headBuffer = inputBuffer.subarray(0, headBytes)
  const tailBuffer = inputBuffer.subarray(originalBytes - tailBytes)

  const headStr = headBuffer.toString('utf8')
  const tailStr = tailBuffer.toString('utf8')

  const omittedBytes = originalBytes - (headBytes + tailBytes)
  const notice =
    options.omissionNotice ??
    `\n\n... [FORGE STREAM BUFFER CEILING: TRUNCATED ${String(omittedBytes)} BYTES] ...\n\n`

  const finalOutput = headStr + notice + tailStr
  const finalBuffer = Buffer.from(finalOutput, 'utf8')

  return {
    valid: true,
    truncated: true,
    originalBytes,
    truncatedBytes: finalBuffer.byteLength,
    omittedBytes,
    output: finalOutput,
    formattedSummary: `OUTPUT BUFFER TRUNCATED: ${String(originalBytes)} bytes -> ${String(finalBuffer.byteLength)} bytes (${String(omittedBytes)} bytes omitted)`,
  }
}

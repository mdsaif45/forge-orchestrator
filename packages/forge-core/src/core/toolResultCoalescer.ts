/**
 * AGENT-018: Multi-turn tool call result coalescer and duplicate observation deduplication supervisor.
 * Identifies duplicate idempotent tool observations within turn history and condenses redundant outputs (Axioms A1, A5).
 */

import { createHash } from 'node:crypto'

export interface ToolObservation {
  readonly id: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly output: string
  readonly timestamp?: string | undefined
}

export interface CoalescePolicy {
  readonly maxLookbackTurns?: number | undefined
  readonly minLengthForDedup?: number | undefined
  readonly deduplicatedTools?: readonly string[] | undefined
}

export interface ObservationFingerprint {
  readonly toolName: string
  readonly argsHash: string
  readonly outputHash: string
  readonly fullHash: string
}

export interface CoalescedTurn {
  readonly index: number
  readonly id: string
  readonly toolName: string
  readonly isDuplicate: boolean
  readonly originalLength: number
  readonly coalescedLength: number
  readonly output: string
  readonly duplicateOfIndex?: number | undefined
}

export interface CoalesceResult {
  readonly originalCount: number
  readonly duplicateCount: number
  readonly savedCharacters: number
  readonly turns: readonly CoalescedTurn[]
  readonly formattedSummary: string
}

/**
 * Computes deterministic SHA-256 fingerprints for a tool invocation and its observation.
 */
export function computeObservationHash(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  output: string,
): ObservationFingerprint {
  const normalizedArgs = JSON.stringify(args, Object.keys(args).sort())
  const argsHash = createHash('sha256').update(normalizedArgs, 'utf8').digest('hex').slice(0, 16)
  const outputHash = createHash('sha256').update(output.trim(), 'utf8').digest('hex').slice(0, 16)
  const fullHash = createHash('sha256')
    .update(`${toolName}:${argsHash}:${outputHash}`, 'utf8')
    .digest('hex')

  return {
    toolName,
    argsHash,
    outputHash,
    fullHash,
  }
}

/**
 * Coalesces duplicate tool observations within a turn sequence.
 */
export function coalesceToolObservations(
  observations: readonly ToolObservation[],
  policy: CoalescePolicy = {},
): CoalesceResult {
  const minLength = policy.minLengthForDedup ?? 40
  const maxLookback = policy.maxLookbackTurns ?? 20
  const allowedToolsSet = policy.deduplicatedTools ? new Set(policy.deduplicatedTools) : undefined

  // Map of fullHash -> first seen turn index
  const seenObservations = new Map<string, number>()
  const resultTurns: CoalescedTurn[] = []

  let duplicateCount = 0
  let savedCharacters = 0

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i]
    if (!obs) continue

    const isEligibleTool = allowedToolsSet ? allowedToolsSet.has(obs.toolName) : true
    const isLongEnough = obs.output.length >= minLength

    if (!isEligibleTool || !isLongEnough) {
      resultTurns.push({
        index: i,
        id: obs.id,
        toolName: obs.toolName,
        isDuplicate: false,
        originalLength: obs.output.length,
        coalescedLength: obs.output.length,
        output: obs.output,
      })
      continue
    }

    const { fullHash } = computeObservationHash(obs.toolName, obs.args, obs.output)
    const priorIndex = seenObservations.get(fullHash)

    // Check if duplicate within lookback window
    if (priorIndex !== undefined && i - priorIndex <= maxLookback) {
      duplicateCount++
      const refPlaceholder = `[Duplicate observation identical to turn #${String(priorIndex)} (${obs.toolName}); output preserved in prior turn]`
      const saved = Math.max(0, obs.output.length - refPlaceholder.length)
      savedCharacters += saved

      resultTurns.push({
        index: i,
        id: obs.id,
        toolName: obs.toolName,
        isDuplicate: true,
        originalLength: obs.output.length,
        coalescedLength: refPlaceholder.length,
        output: refPlaceholder,
        duplicateOfIndex: priorIndex,
      })
    } else {
      seenObservations.set(fullHash, i)
      resultTurns.push({
        index: i,
        id: obs.id,
        toolName: obs.toolName,
        isDuplicate: false,
        originalLength: obs.output.length,
        coalescedLength: obs.output.length,
        output: obs.output,
      })
    }
  }

  const summary =
    duplicateCount === 0
      ? `✓ All ${String(observations.length)} tool observation(s) unique; no duplicates coalesced.`
      : `✓ Coalesced ${String(duplicateCount)} duplicate observation(s) across ${String(observations.length)} turns (saved ~${String(savedCharacters)} chars).`

  return {
    originalCount: observations.length,
    duplicateCount,
    savedCharacters,
    turns: resultTurns,
    formattedSummary: summary,
  }
}

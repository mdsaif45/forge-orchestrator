import { describe, it, expect } from 'vitest'
import {
  computeObservationHash,
  coalesceToolObservations,
  type ToolObservation,
} from './toolResultCoalescer'

describe('ToolResultCoalescer (AGENT-018)', () => {
  it('computes deterministic fingerprints regardless of argument key order', () => {
    const fp1 = computeObservationHash(
      'file_read',
      { path: 'src/main.ts', encoding: 'utf8' },
      'file content',
    )
    const fp2 = computeObservationHash(
      'file_read',
      { encoding: 'utf8', path: 'src/main.ts' },
      'file content',
    )

    expect(fp1.fullHash).toBe(fp2.fullHash)
    expect(fp1.argsHash).toBe(fp2.argsHash)
  })

  it('preserves all unique observations without alteration', () => {
    const obs: ToolObservation[] = [
      {
        id: '1',
        toolName: 'file_read',
        args: { path: 'a.ts' },
        output: 'content of file a that is sufficiently long',
      },
      {
        id: '2',
        toolName: 'file_read',
        args: { path: 'b.ts' },
        output: 'content of file b that is sufficiently long',
      },
    ]

    const result = coalesceToolObservations(obs)
    expect(result.duplicateCount).toBe(0)
    expect(result.turns[0]?.isDuplicate).toBe(false)
    expect(result.turns[1]?.isDuplicate).toBe(false)
    expect(result.formattedSummary).toContain('no duplicates coalesced')
  })

  it('coalesces repeated duplicate tool observations and records original turn index', () => {
    const longOutput =
      'export const CONFIG = { enabled: true, debugMode: false, maxRetries: 10, timeoutSeconds: 30 };'
    const obs: ToolObservation[] = [
      { id: '1', toolName: 'file_read', args: { path: 'src/config.ts' }, output: longOutput },
      { id: '2', toolName: 'bash', args: { cmd: 'npm test' }, output: 'Tests passing' },
      { id: '3', toolName: 'file_read', args: { path: 'src/config.ts' }, output: longOutput }, // duplicate of 0
    ]

    const result = coalesceToolObservations(obs)
    expect(result.duplicateCount).toBe(1)
    expect(result.turns[0]?.isDuplicate).toBe(false)
    expect(result.turns[2]?.isDuplicate).toBe(true)
    expect(result.turns[2]?.duplicateOfIndex).toBe(0)
    expect(result.turns[2]?.output).toContain('Duplicate observation identical to turn #0')
    expect(result.savedCharacters).toBeGreaterThan(0)
  })

  it('respects minLengthForDedup threshold to ignore short trivial outputs', () => {
    const obs: ToolObservation[] = [
      { id: '1', toolName: 'ping', args: {}, output: 'ok' },
      { id: '2', toolName: 'ping', args: {}, output: 'ok' },
    ]

    const result = coalesceToolObservations(obs, { minLengthForDedup: 10 })
    expect(result.duplicateCount).toBe(0)
    expect(result.turns[1]?.isDuplicate).toBe(false)
  })

  it('respects maxLookbackTurns policy', () => {
    const longOutput =
      'A very long repeated output string that meets the minimum length requirement for deduplication.'
    const obs: ToolObservation[] = [
      { id: '1', toolName: 'status', args: {}, output: longOutput },
      {
        id: '2',
        toolName: 'other',
        args: {},
        output: 'intermediate step 1 that has sufficient length',
      },
      {
        id: '3',
        toolName: 'other',
        args: {},
        output: 'intermediate step 2 that has sufficient length',
      },
      { id: '4', toolName: 'status', args: {}, output: longOutput },
    ]

    // With lookback = 2, turn 3 is 3 turns away from turn 0 (distance 3 > 2), so not coalesced
    const resultLimited = coalesceToolObservations(obs, { maxLookbackTurns: 2 })
    expect(resultLimited.duplicateCount).toBe(0)

    // With lookback = 5, it is coalesced
    const resultWide = coalesceToolObservations(obs, { maxLookbackTurns: 5 })
    expect(resultWide.duplicateCount).toBe(1)
    expect(resultWide.turns[3]?.isDuplicate).toBe(true)
  })
})

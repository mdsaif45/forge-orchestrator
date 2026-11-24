import { describe, expect, it } from 'vitest'
import { AgentToolCallDeduplicationLedger } from './agentToolCallDeduplicationLedger'

describe('AgentToolCallDeduplicationLedger', () => {
  it('canonicalizes parameters independently of property insertion order', () => {
    const ledger = new AgentToolCallDeduplicationLedger()
    const p1 = { z: 1, a: 2, m: { y: 'test', x: 10 } }
    const p2 = { a: 2, m: { x: 10, y: 'test' }, z: 1 }

    expect(ledger.canonicalize(p1)).toBe(ledger.canonicalize(p2))
  })

  it('computes identical fingerprints for equivalent invocations', () => {
    const ledger = new AgentToolCallDeduplicationLedger()
    const f1 = ledger.computeFingerprint('read_file', { path: 'src/main.ts', line: 1 }, 'ws-1')
    const f2 = ledger.computeFingerprint('read_file', { line: 1, path: 'src/main.ts' }, 'ws-1')

    expect(f1.fingerprint).toBe(f2.fingerprint)
    expect(f1.paramsHash).toBe(f2.paramsHash)

    // Workspace hash difference alters fingerprint
    const f3 = ledger.computeFingerprint('read_file', { line: 1, path: 'src/main.ts' }, 'ws-2')
    expect(f3.fingerprint).not.toBe(f1.fingerprint)
  })

  it('atomically locks novel invocations and blocks concurrent in-flight duplicates', () => {
    const ledger = new AgentToolCallDeduplicationLedger()
    const eval1 = ledger.evaluateAndLock('compile_code', { target: 'all' })

    expect(eval1.isDuplicate).toBe(false)
    expect(eval1.canProceed).toBe(true)
    expect(ledger.getEntry(eval1.fingerprint)?.status).toBe('IN_FLIGHT')

    // Second immediate call with identical parameters
    const eval2 = ledger.evaluateAndLock('compile_code', { target: 'all' })
    expect(eval2.isDuplicate).toBe(true)
    expect(eval2.canProceed).toBe(false)
    expect(eval2.existingStatus).toBe('IN_FLIGHT')
    expect(eval2.reason).toContain('currently in flight')
  })

  it('completes invocations and returns cached results to subsequent callers', () => {
    const ledger = new AgentToolCallDeduplicationLedger({ defaultTtlMs: 5000 })
    const eval1 = ledger.evaluateAndLock('get_weather', { city: 'Tokyo' })

    const outputPayload = { temp: 22, conditions: 'clear' }
    const completed = ledger.complete(eval1.fingerprint, outputPayload)
    expect(completed.status).toBe('COMPLETED')
    expect(completed.result).toEqual(outputPayload)

    // Subsequent evaluation gets cached result
    const eval2 = ledger.evaluateAndLock('get_weather', { city: 'Tokyo' })
    expect(eval2.isDuplicate).toBe(true)
    expect(eval2.canProceed).toBe(false)
    expect(eval2.existingStatus).toBe('COMPLETED')
    expect(eval2.cachedResult).toEqual(outputPayload)
  })

  it('releases in-flight reservation on execution abort/failure', () => {
    const ledger = new AgentToolCallDeduplicationLedger()
    const eval1 = ledger.evaluateAndLock('flaky_tool', { id: 1 })
    expect(eval1.canProceed).toBe(true)

    const released = ledger.release(eval1.fingerprint)
    expect(released).toBe(true)
    expect(ledger.getEntry(eval1.fingerprint)).toBeUndefined()

    // Can proceed again after release
    const eval2 = ledger.evaluateAndLock('flaky_tool', { id: 1 })
    expect(eval2.canProceed).toBe(true)
  })

  it('evicts expired entries after TTL elapsed', async () => {
    const ledger = new AgentToolCallDeduplicationLedger({ defaultTtlMs: 50 })
    const eval1 = ledger.evaluateAndLock('short_lived_tool', { attempt: 1 }, undefined, 50)
    ledger.complete(eval1.fingerprint, { ok: true }, 50)

    await new Promise((resolve) => setTimeout(resolve, 80))

    const entry = ledger.getEntry(eval1.fingerprint)
    expect(entry?.status).toBe('EXPIRED')

    // Calling evaluateAndLock again after expiration allows re-execution
    const eval2 = ledger.evaluateAndLock('short_lived_tool', { attempt: 1 }, undefined, 50)
    expect(eval2.canProceed).toBe(true)
    expect(eval2.isDuplicate).toBe(false)
  })

  it('bounds capacity by pruning oldest entries on overflow', () => {
    const ledger = new AgentToolCallDeduplicationLedger({ maxEntries: 3 })
    ledger.evaluateAndLock('tool', { i: 1 })
    ledger.evaluateAndLock('tool', { i: 2 })
    ledger.evaluateAndLock('tool', { i: 3 })
    expect(ledger.size()).toBe(3)

    // 4th insert should prune oldest
    ledger.evaluateAndLock('tool', { i: 4 })
    expect(ledger.size()).toBe(3)
  })

  it('throws error when completing non-existent fingerprint', () => {
    const ledger = new AgentToolCallDeduplicationLedger()
    expect(() => ledger.complete('non-existent-hash', {})).toThrow('Cannot complete unknown')
  })
})

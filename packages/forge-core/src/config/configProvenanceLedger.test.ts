import { describe, it, expect } from 'vitest'
import { ConfigProvenanceLedger, type ConfigSnapshot } from './configProvenanceLedger'

describe('ConfigProvenanceLedger (CONFIG-024)', () => {
  it('records snapshots with cryptographic hash chain linking', () => {
    const ledger = new ConfigProvenanceLedger()

    const snap1 = ledger.recordSnapshot({
      author: 'admin',
      reason: 'initial setup',
      configState: { theme: 'dark', telemetryEnabled: false },
    })

    expect(snap1.parentChecksum).toBeNull()
    expect(snap1.checksum).toHaveLength(64)

    const snap2 = ledger.recordSnapshot({
      author: 'ci-bot',
      reason: 'enable telemetry',
      configState: { theme: 'dark', telemetryEnabled: true },
    })

    expect(snap2.parentChecksum).toBe(snap1.checksum)
    expect(snap2.checksum).toHaveLength(64)

    const report = ledger.verifyLedgerIntegrity()
    expect(report.valid).toBe(true)
    expect(report.totalSnapshots).toBe(2)
  })

  it('detects tampering when snapshot content is modified', () => {
    const ledger = new ConfigProvenanceLedger()

    ledger.recordSnapshot({
      author: 'alice',
      reason: 'v1 config',
      configState: { maxTokens: 1000 },
    })

    ledger.recordSnapshot({
      author: 'bob',
      reason: 'v2 config',
      configState: { maxTokens: 2000 },
    })

    // Export snapshots and tamper with s1 configState
    const exported = JSON.parse(ledger.exportLedgerJson()) as ConfigSnapshot[]
    const tampered = exported.map((snap, idx) => {
      if (idx === 0) {
        return {
          ...snap,
          configState: { maxTokens: 999999 }, // Tampered value
        }
      }
      return snap
    })

    const tamperedLedger = new ConfigProvenanceLedger(tampered)
    const report = tamperedLedger.verifyLedgerIntegrity()

    expect(report.valid).toBe(false)
    expect(report.brokenAtIndex).toBe(0)
    expect(report.error).toContain('Checksum tampering detected')
  })

  it('rolls back to an earlier snapshot by appending a new rollback snapshot', () => {
    const ledger = new ConfigProvenanceLedger()

    const s1 = ledger.recordSnapshot({
      author: 'admin',
      reason: 'stable base',
      configState: { maxRetries: 3, debug: false },
    })

    ledger.recordSnapshot({
      author: 'dev',
      reason: 'break things',
      configState: { maxRetries: 100, debug: true },
    })

    const rollbackSnap = ledger.rollbackTo(s1.snapshotId, 'admin', 'revert bad config')

    expect(rollbackSnap.configState).toEqual({ maxRetries: 3, debug: false })
    expect(rollbackSnap.tags).toContain('rollback')
    expect(rollbackSnap.tags).toContain(`reverted-to:${s1.snapshotId}`)

    // Ledger has 3 snapshots and remains completely valid
    expect(ledger.listSnapshots()).toHaveLength(3)
    const report = ledger.verifyLedgerIntegrity()
    expect(report.valid).toBe(true)
  })

  it('diffs two snapshots identifying added, modified, and removed keys', () => {
    const ledger = new ConfigProvenanceLedger()

    const s1 = ledger.recordSnapshot({
      author: 'a',
      reason: 'r1',
      configState: { unchanged: 1, removedKey: 'foo', modifiedKey: 'old' },
    })

    const s2 = ledger.recordSnapshot({
      author: 'b',
      reason: 'r2',
      configState: { unchanged: 1, addedKey: 'new', modifiedKey: 'updated' },
    })

    const diffs = ledger.diffSnapshots(s1.snapshotId, s2.snapshotId)

    expect(diffs).toEqual([
      { path: 'addedKey', changeType: 'ADDED', oldValue: undefined, newValue: 'new' },
      { path: 'modifiedKey', changeType: 'MODIFIED', oldValue: 'old', newValue: 'updated' },
      { path: 'removedKey', changeType: 'REMOVED', oldValue: 'foo', newValue: undefined },
    ])
  })

  it('exports and imports ledger JSON with verified round-trip integrity', () => {
    const ledger = new ConfigProvenanceLedger()
    ledger.recordSnapshot({
      author: 'tester',
      reason: 'first',
      configState: { env: 'staging' },
    })
    ledger.recordSnapshot({
      author: 'tester',
      reason: 'second',
      configState: { env: 'production' },
    })

    const exportedJson = ledger.exportLedgerJson()
    const imported = ConfigProvenanceLedger.importLedgerJson(exportedJson)

    expect(imported.listSnapshots()).toHaveLength(2)
    expect(imported.verifyLedgerIntegrity().valid).toBe(true)
  })

  it('throws when attempting to rollback to non-existent snapshot', () => {
    const ledger = new ConfigProvenanceLedger()
    ledger.recordSnapshot({
      author: 'root',
      reason: 'init',
      configState: {},
    })

    expect(() => ledger.rollbackTo('missing-snap-id', 'root', 'test')).toThrow(
      /Target snapshot 'missing-snap-id' not found/,
    )
  })
})

import { describe, expect, it } from 'vitest'
import { SqliteHotBackupPointInTimeRestorer } from './sqliteHotBackupPointInTimeRestorer'

describe('SqliteHotBackupPointInTimeRestorer (STATE-026)', () => {
  it('creates hot backup snapshots with deterministic SHA-256 integrity seal', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer({ pagesPerStep: 50 })
    const now = 1_000_000

    const { snapshot, stepsCompleted } = restorer.createHotBackupSnapshot(
      'db-main',
      120,
      'sample_data',
      now,
    )

    expect(snapshot.databaseId).toBe('db-main')
    expect(snapshot.baseLsn).toBe(0)
    expect(snapshot.totalPages).toBe(120)
    expect(snapshot.sha256Checksum).toHaveLength(64)
    expect(snapshot.status).toBe('completed')
    expect(stepsCompleted).toBe(3) // 120 / 50 = ceil(2.4) = 3 steps
  })

  it('records WAL events with sequential LSNs and chained hashes', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer()
    const ev1 = restorer.recordWalEvent('db-main', 'tx-1', 'INSERT INTO runs VALUES (1);', 1000)
    const ev2 = restorer.recordWalEvent('db-main', 'tx-2', 'UPDATE runs SET status=2;', 1005)

    expect(ev1.lsn).toBe(1)
    expect(ev2.lsn).toBe(2)
    expect(ev1.checksum).toHaveLength(64)
    expect(ev2.checksum).toHaveLength(64)
    expect(ev1.checksum).not.toBe(ev2.checksum)
    expect(restorer.getCurrentLsn()).toBe(2)
  })

  it('plans point-in-time recovery to target LSN with correct replay partitioning', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer()

    // 1. Initial snapshot taken at LSN 0
    const { snapshot } = restorer.createHotBackupSnapshot('db-main', 100)

    // 2. Three WAL events recorded
    restorer.recordWalEvent('db-main', 'tx-1', 'INSERT 1')
    restorer.recordWalEvent('db-main', 'tx-2', 'INSERT 2')
    restorer.recordWalEvent('db-main', 'tx-3', 'INSERT 3')

    // 3. Plan PITR recovery to LSN 2
    const plan = restorer.planPointInTimeRecovery(snapshot.snapshotId, { targetLsn: 2 })
    expect(plan.isValid).toBe(true)
    expect(plan.targetLsn).toBe(2)
    expect(plan.snapshotBaseLsn).toBe(0)
    expect(plan.replayedEventCount).toBe(2)
    expect(plan.excludedEventCount).toBe(1)
    expect(plan.replayedLsns).toEqual([1, 2])
  })

  it('plans point-in-time recovery by target timestamp', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer()
    const baseTime = 1_000_000

    const { snapshot } = restorer.createHotBackupSnapshot('db-main', 100, 'data', baseTime)

    restorer.recordWalEvent('db-main', 'tx-1', 'SQL 1', baseTime + 100) // LSN 1
    restorer.recordWalEvent('db-main', 'tx-2', 'SQL 2', baseTime + 200) // LSN 2
    restorer.recordWalEvent('db-main', 'tx-3', 'SQL 3', baseTime + 300) // LSN 3

    // Request PITR target at baseTime + 250 -> Should recover up to LSN 2
    const plan = restorer.planPointInTimeRecovery(snapshot.snapshotId, {
      targetTimestamp: baseTime + 250,
    })
    expect(plan.isValid).toBe(true)
    expect(plan.targetLsn).toBe(2)
    expect(plan.replayedLsns).toEqual([1, 2])
  })

  it('executes PITR restoration and verifies event continuity', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer()
    const { snapshot } = restorer.createHotBackupSnapshot('db-main', 50)

    restorer.recordWalEvent('db-main', 'tx-1', 'STMT 1', 5000)
    restorer.recordWalEvent('db-main', 'tx-2', 'STMT 2', 6000)

    const plan = restorer.planPointInTimeRecovery(snapshot.snapshotId, { targetLsn: 2 })
    const result = restorer.executeRestore(plan)

    expect(result.success).toBe(true)
    expect(result.restoredLsn).toBe(2)
    expect(result.finalTimestamp).toBe(6000)
    expect(result.integrityVerified).toBe(true)
  })

  it('fails closed when planning recovery for nonexistent or corrupt snapshot', () => {
    const restorer = new SqliteHotBackupPointInTimeRestorer()
    const plan = restorer.planPointInTimeRecovery('nonexistent-id', { targetLsn: 1 })

    expect(plan.isValid).toBe(false)
    expect(plan.validationError).toContain('does not exist in registry')

    const result = restorer.executeRestore(plan)
    expect(result.success).toBe(false)
    expect(result.error).toContain('does not exist in registry')
  })
})

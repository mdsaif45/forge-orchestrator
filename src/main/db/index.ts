import { openDatabase, type ForgeDatabase, type OpenDatabaseResult } from './connection'
import { MIGRATIONS } from './migrations.generated'
import { runMigrations } from './migrate'

export {
  openDatabase,
  readPragmas,
  type ForgeDatabase,
  type OpenDatabaseResult,
} from './connection'
export { loadMigrations, readAppliedCount, runMigrations, type Migration } from './migrate'
export {
  planResume,
  resumeDecisionSchema,
  WorkflowStore,
  computeTransitionId,
  WorkflowDomainError,
  ConflictingTargetNodeError,
  ConflictingIterationError,
  TargetIterationAlreadyActivatedError,
  CompetingTransitionError,
  TerminalGraphRunError,
  InvalidIterationAdvanceError,
  SourceAttemptNotFoundError,
  SourceAttemptNotCompletedError,
  DatabaseLockTimeoutError,
  FatalStateCorruptionError,
  InconsistentPersistenceStateError,
  type ResumeDecision,
  type ResumePlan,
  type StartWorkflowInput,
  type AdvanceLoopIterationInput,
  type AdvanceLoopIterationResult,
} from './workflowStore'
export { RunStore } from './runStore'
export { ArtifactStore } from './artifactStore'
export { AgentInstanceStore } from './agentInstanceStore'
export { CustomRuntimeStore, type CustomRuntimeRecord } from './customRuntimeStore'
export {
  getDatabaseStats,
  vacuumDatabase,
  type DatabaseStats,
  type TableRowStat,
  type VacuumResult,
} from './maintenance'
export {
  backupDatabase,
  restoreDatabase,
  type DatabaseBackupResult,
  type DatabaseRestoreResult,
  type RestoreOptions,
} from './backup'
export {
  compactRunEvents,
  type EventCompactionOptions,
  type EventCompactionResult,
} from './eventCompactor'
export {
  inspectProjectRegistry,
  pruneMissingProjects,
  type ProjectPruneResult,
  type ProjectRegistryReport,
  type ProjectSummary,
} from './projectRegistry'
export {
  auditDatabaseIntegrity,
  pruneOrphanedDatabaseRecords,
  type DatabaseIntegrityReport,
  type DatabasePruneResult,
} from './dbIntegrityAuditor'
export {
  auditDatabaseStorageQuota,
  executeWalCheckpoint,
  type StorageQuotaReport,
  type WalCheckpointResult,
} from './walCheckpointSupervisor'
export {
  computeChainedEventHash,
  exportEventJournal,
  GENESIS_HASH,
  verifyEventJournalHashChain,
  type EventJournalExportReport,
  type JournalEntry,
  type JournalVerificationReport,
  type RawLedgerEvent,
} from './eventJournalExporter'
export {
  replayEventLedger,
  type RunStateProjection,
  type StepProjection,
} from './eventReplayEngine'
export {
  verifyLedgerReplication,
  type CrossTableAuditCounts,
  type LedgerReplicationReport,
} from './ledgerVerifier'
export {
  diffDatabaseSnapshots,
  type TableRowDiff,
  type TableDelta,
  type DatabaseSnapshotDiffReport,
  type DatabaseSnapshotDiffOptions,
} from './snapshotDiffer'
export { DatabaseSavepointManager, type SavepointReceipt } from './savepointManager'
export {
  searchDatabaseEvents,
  generateSearchSnippet,
  type EventSearchQuery,
  type EventSearchHit,
  type EventSearchReport,
} from './eventSearchEngine'
export {
  computeSqlChecksum,
  ensureMigrationLedgerTable,
  getAppliedMigrations,
  getMigrationStatus,
  verifyMigrationIntegrity,
  applyPendingMigrations,
  type MigrationDefinition,
  type MigrationRecord,
  type MigrationStatus,
  type MigrationIntegrityReport,
  type MigrationExecutionResult,
} from './schemaMigrationRunner'
export {
  validateReadOnlySql,
  executeSandboxedQuery,
  type QueryValidationResult,
  type SandboxedQueryResult,
  type SandboxOptions,
} from './querySandbox'
export {
  analyzeQueryPlan,
  auditTableIndexes,
  parseQueryPlanRows,
  type IndexAuditReport,
  type QueryPlanAnalysis,
  type QueryPlanNode,
  type TableIndexHealth,
  type TableIndexInfo,
} from './queryAnalyzer'
export {
  computeJournalDiff,
  auditDatabaseJournalRange,
  type LedgerEventInput,
  type MutationKind,
  type EntityMutationDelta,
  type CompensatingEvent,
  type JournalDiffOptions,
  type JournalDiffReport,
} from './journalDiffAuditor'
export {
  sanitizeProjectId,
  computeShardFileName,
  resolveShardPath,
  auditShardRegistry,
  type ShardRoutingInfo,
  type ShardRegistryReport,
  type ShardRouterOptions,
} from './partitionShardRouter'

export * as schema from './schema'
export { MIGRATIONS } from './migrations.generated'

/**
 * Opens the database and brings it up to date.
 *
 * Idempotent: a second call on an already-migrated file applies nothing. The
 * `applied` count is returned so startup can log whether it did work, which turns
 * "did the migration run?" into an observation rather than an assumption.
 */
export function initialiseDatabase(file: string): {
  readonly db: ForgeDatabase
  readonly sqlite: OpenDatabaseResult['sqlite']
  readonly close: () => void
  readonly applied: number
} {
  const { db, sqlite, close } = openDatabase({ file })

  try {
    const applied = runMigrations(db, MIGRATIONS)
    return { db, sqlite, close, applied }
  } catch (error) {
    // Leaving the handle open on a failed migration would hold a lock on a
    // database the app cannot use.
    close()
    throw error
  }
}

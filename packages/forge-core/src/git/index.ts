export { GitCommandError, runGit, type GitExecOptions } from './exec'
export {
  DirtyWorktreeError,
  GitService,
  NotARepositoryError,
  type DiffOptions,
  type DiffResult,
  type GitServiceOptions,
  type Snapshot,
} from './gitService'
export {
  joinDiffFiles,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  type DiffFile,
  type StatusEntry,
  type StatusResult,
} from './parse'
export {
  WorktreeService,
  type PreparedWorktree,
  type WorktreeServiceOptions,
} from './worktreeService'
export {
  WorktreeIsolationManager,
  WorktreeIsolationError,
  WorktreeLockConflictError,
  EmptyRepositoryIsolationError,
  type IsolationScope,
  type WorktreeLockState,
  type IsolationScopeConfig,
  type WorktreeLeaseSnapshot,
  type WorktreeCleanupReport,
  type WorktreeLease,
  type CleanupHook,
  type WorktreeInventoryEntry,
  type WorktreeListResult,
  type WorktreeIsolationManagerOptions,
} from './worktreeIsolationManager'

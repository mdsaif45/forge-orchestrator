export {
  buildChangeSet,
  diffStatOf,
  type BuildChangeSetInput,
  type BuiltChangeSet,
} from './changeSetBuilder'

export { runCommand, type RunCommandInput } from './commandRunner'

export { parseTestCounts } from './testParsers'

export { verifyStep, type VerifyInput, type VerifyResult } from './verifier'

export {
  auditAdversarialEvidence,
  type AdversarialAuditInput,
  type AdversarialAuditResult,
  type AdversarialFinding,
  type AdversarialFindingCode,
} from './adversarial'

export {
  mergeChangeSets,
  normalizePath,
  type ChangeSetMergeResult,
  type MergeBranchInput,
  type MergeConflictDetail,
  type MergeConflictType,
} from './changeSetMerger'

export {
  inspectRunDiff,
  parseUnifiedDiff,
  type FileDiffStat,
  type InspectRunDiffOptions,
  type RunDiffReport,
} from './diffInspector'

export {
  auditArtifactChecksums,
  type ArtifactAuditResult,
  type ChecksumAuditReport,
} from './checksumAudit'

export {
  executeVerificationPipeline,
  writeVerificationPipelineArtifact,
  type VerificationPipelineInput,
  type VerificationPipelineReport,
  type VerificationStepResult,
  type VerificationStepSpec,
} from './verificationPipeline'

export {
  applyRollbackPatch,
  generateReversePatch,
  rollbackRunChanges,
  type RollbackResult,
} from './patchRollback'

export {
  auditDiffSecurity,
  auditRunChangesetSecurity,
  type SecurityAuditOptions,
  type SecurityAuditReport,
  type SecurityViolation,
  type SecurityViolationSeverity,
} from './securityAuditor'
export {
  synthesizeChangesetCommit,
  synthesizeRunChangesetCommit,
  type CommitType,
  type SynthesizeCommitOptions,
  type SynthesizedCommitReport,
} from './changesetSynthesizer'
export {
  auditRunChangesetConflicts,
  detectChangesetConflicts,
  mergeChangesetDiffs,
  type ChangesetConflictReport,
  type ChangesetMergeResult,
  type DiffHunk,
  type FileConflict,
  type FileDiff,
} from './changesetConflictDetector'
export {
  auditChangesetCoverage,
  auditRunCoverage,
  extractModifiedLineNumbers,
  parseLcov,
  type CoverageAuditReport,
  type FileCoverageData,
  type ModifiedFileLineCoverage,
} from './coverageAuditor'
export {
  calculateShannonEntropy,
  redactSecret,
  scanDiffForSecretLeaks,
  scanTextForSecretLeaks,
  type SecretPattern,
  type SecretScanResult,
  type SecretSeverity,
  type SecretViolation,
} from './secretLeakScanner'
export {
  ALLOWED_COMMIT_TYPES,
  validateCommitMessage,
  type CommitFooter,
  type CommitValidationResult,
} from './commitValidator'

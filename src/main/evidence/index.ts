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
export {
  computeArtifactLeafHash,
  generateArtifactMerkleTree,
  verifyMerkleProof,
  type ArtifactInfo,
  type ArtifactMerkleReport,
  type MerkleLeafRecord,
  type MerkleProofStep,
} from './merkleLineage'
export {
  computeManifestFingerprint,
  generateVerificationManifest,
  verifyManifestIntegrity,
  type ManifestCommandEntry,
  type ManifestCriterionEntry,
  type ManifestFileEntry,
  type ManifestIntegrityReport,
  type VerificationManifest,
  type VerificationManifestInput,
} from './verificationManifest'
export {
  auditChangesetExportSurface,
  type ExportChangeKind,
  type ExportRiskTier,
  type ExportSymbolChange,
  type ExportSymbolKind,
  type ExportSurfaceReport,
} from './exportSurfaceAuditor'
export {
  auditPatchFuzziness,
  parseDiffHunks,
  type HunkStatus,
  type HunkAuditResult,
  type FileHunkAuditReport,
  type PatchFuzzReport,
  type PatchFuzzOptions,
} from './patchFuzzAuditor'
export {
  AssertionReportAggregator,
  type TestCaseAssertion,
  type TestSuiteAssertion,
  type AssertionReportSummary,
} from './assertionReporter'
export {
  auditDependencyCycles,
  extractImportSpecifiers,
  type DependencyCycleReport,
} from './dependencyCycleAuditor'
export {
  stripAnsiCodes,
  extractDiagnosticFailures,
  sanitizeExecutionLog,
  type DiagnosticFailure,
  type LogSanitizationResult,
} from './logSanitizer'
export {
  parseJUnitXmlReport,
  parseTapStreamReport,
  parseUniversalTestReport,
  type TestCaseResult,
  type TestSuiteResult,
  type UnifiedTestReport,
} from './unifiedTestParser'
export {
  computeStatementDigest,
  generateProvenanceStatement,
  verifyProvenanceStatement,
  IN_TOTO_STATEMENT_V1,
  SLSA_PROVENANCE_V1,
  FORGE_BUILD_TYPE_V1,
  type GenerateProvenanceInput,
  type ProvenanceDigest,
  type ProvenanceInvocation,
  type ProvenanceMaterial,
  type ProvenanceMetadata,
  type ProvenanceStatement,
  type ProvenanceSubject,
  type ProvenanceVerificationResult,
  type SlsaPredicateV1,
} from './provenanceAttestation'
export {
  selectAffectedTestSuites,
  DEFAULT_GLOBAL_IMPACT_PATTERNS,
  type ChangeImpactOptions,
  type ImpactAnalysisReport,
} from './changeImpactSelector'
export {
  chunkUnifiedDiff,
  classifyFilePath,
  type SemanticCategory,
  type SemanticDiffChunk,
  type SemanticDiffReport,
  type SemanticChunkingOptions,
} from './diffSemanticChunker'
export {
  traceSymbolDependencies,
  type SymbolChangeType,
  type ContractRiskLevel,
  type ModifiedSymbol,
  type SymbolConsumerMap,
  type ContractRisk,
  type SymbolTraceReport,
} from './diffSymbolDependencyTracer'
export {
  auditChangesetPaths,
  type PathViolationSeverity,
  type PathViolation,
  type PathTraversalAuditorOptions,
  type PathSecurityAuditReport,
} from './changesetPathTraversalAuditor'

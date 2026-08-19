/**
 * The domain model — Forge's single definition of the project truth (axiom A1).
 *
 * Everything here is a zod schema plus its inferred type, so one declaration
 * serves persistence, the IPC contract, and agent prompt packets. A field cannot
 * exist in the database and be missing from a packet, or vice versa.
 *
 * Two constraints hold throughout:
 *
 *   - **no provider-specific fields** (axiom A6). Runtime and account identifiers
 *     are opaque strings; nothing here knows that Claude or Antigravity exist.
 *   - **no environment imports**. This directory compiles into main, preload, and
 *     the renderer, so it stays pure data and pure functions.
 */

export {
  actorSchema,
  agentBindingIdSchema,
  changeSetIdSchema,
  decisionIdSchema,
  eventIdSchema,
  evidenceIdSchema,
  projectIdSchema,
  questionIdSchema,
  repoPathSchema,
  repositoryIdSchema,
  ruleIdSchema,
  shaSchema,
  stepIdSchema,
  taskIdSchema,
  timestampSchema,
  workflowIdSchema,
  type Actor,
  type AgentBindingId,
  type ChangeSetId,
  type DecisionId,
  type EventId,
  type EvidenceId,
  type ProjectId,
  type QuestionId,
  type RepoPath,
  type RepositoryId,
  type RuleId,
  type Sha,
  type StepId,
  type TaskId,
  type Timestamp,
  type WorkflowId,
} from './ids'

export {
  capabilitySchema,
  changeTypeSchema,
  criterionKindSchema,
  decisionStatusSchema,
  isTerminalWorkflowState,
  reportStatusSchema,
  roleSchema,
  ruleScopeSchema,
  ruleScopeSpecificity,
  RULE_SCOPES,
  TERMINAL_WORKFLOW_STATES,
  verdictSchema,
  workflowStateSchema,
  WORKFLOW_STATES,
  type Capability,
  type ChangeType,
  type CriterionKind,
  type DecisionStatus,
  type ReportStatus,
  type Role,
  type RuleScope,
  type Verdict,
  type WorkflowState,
} from './enums'

export {
  agentBindingSchema,
  permissionsSchema,
  projectSchema,
  repositorySchema,
  ruleSchema,
  type AgentBinding,
  type Permissions,
  type Project,
  type Repository,
  type Rule,
} from './project'

export {
  decisionSchema,
  lockedDecisionSchema,
  type Decision,
  type LockedDecision,
} from './decision'

export {
  evidenceRefSchema,
  isAnswered,
  openQuestionSchema,
  type EvidenceRef,
  type OpenQuestion,
} from './question'

export {
  completionCriterionSchema,
  scopePolicySchema,
  taskSchema,
  type CompletionCriterion,
  type ScopePolicy,
  type Task,
} from './task'

export {
  workflowCheckpointSchema,
  workflowLimitsSchema,
  workflowSchema,
  workflowStepSchema,
  type Workflow,
  type WorkflowCheckpoint,
  type WorkflowLimits,
  type WorkflowStep,
} from './workflow'

export {
  changedFileSchema,
  changeSetSchema,
  changeSetSize,
  discrepancySchema,
  isEmptyChangeSet,
  type ChangedFile,
  type ChangeSet,
  type Discrepancy,
} from './changeset'

export {
  evidenceArtifactSchema,
  evidenceFindings,
  evidencePassed,
  runOutcomeSchema,
  summariseEvidence,
  testCountsSchema,
  type EvidenceArtifact,
  type RunOutcome,
  type TestCounts,
} from './evidence'

export {
  domainEventSchema,
  eventTypeSchema,
  EVENT_TYPES,
  type DomainEvent,
  type EventType,
} from './event'

export { EVENT_PAYLOADS, type EventInput, type EventPayloads } from './eventPayloads'

export {
  formatPolicyForAgent,
  isOverridden,
  POLICY_SCOPES,
  resolveEffectivePolicy,
  type EffectiveRule,
  type ResolvableRule,
  type ShadowedRule,
} from './policy'

export { FORGE_DEFAULT_RULES, FORGE_DEFAULT_RULE_KEYS, type DefaultRule } from './forgeRules'

export {
  agentReportSchema,
  canHoldRole,
  hasDisqualifyingAssumptions,
  missingCapabilities,
  promptPacketSchema,
  ROLE_REQUIRED_CAPABILITIES,
  runtimeEventSchema,
  runtimeIdSchema,
  runtimeSessionStateSchema,
  runtimeStatusSchema,
  sessionIdSchema,
  type AgentReport,
  type AgentSessionId,
  type IAgentRuntime,
  type PromptPacket,
  type RuntimeEvent,
  type RuntimeId,
  type RuntimeSessionState,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
} from './runtime'

export {
  assessReport,
  parseAgentReport,
  protocolErrorCodeSchema,
  renderPromptPacket,
  REPORT_BEGIN,
  REPORT_END,
  REPORT_INSTRUCTIONS,
  reportVerdictSchema,
  type ProtocolErrorCode,
  type ProtocolFailure,
  type ProtocolResult,
  type ProtocolSuccess,
  type ReportAssessment,
  type ReportVerdict,
} from './protocol'

export {
  canTransition,
  IllegalTransitionError,
  legalTriggers,
  parseWorkflowState,
  renderStateDiagram,
  transition,
  TRANSITIONS,
  workflowTriggerSchema,
  WORKFLOW_TRIGGERS,
  type Transition,
  type TransitionContext,
  type TransitionResult,
  type WorkflowTrigger,
} from './transitions'

export {
  checkBudgets,
  checkStopConditions,
  decideRetry,
  detectNoProgress,
  failureKindSchema,
  fingerprintChange,
  haltCodeSchema,
  haltStateFor,
  HALT_CODES,
  remainingBudget,
  type BudgetState,
  type FailureKind,
  type HaltCode,
  type HaltDecision,
  type RemainingBudget,
  type RetryDecision,
  type StepOutcomeSignals,
} from './guards'

export {
  limitRuleKey,
  limitRuleProblemSchema,
  resolveLimits,
  type LimitRuleProblem,
  type ResolvedLimits,
} from './limitRules'

export { isForbiddenPath, redactSecrets, REDACTION } from './redaction'

export {
  compileContext,
  rankFiles,
  truncationNotice,
  type CompiledContext,
  type ContextBudget,
  type ContextInput,
  type ContextTrace,
  type FileCandidate,
} from './contextEngine'

export {
  FEATURE_IMPLEMENTATION,
  templateStepSchema,
  TEMPLATES,
  validateTemplate,
  workflowTemplateSchema,
  type TemplateId,
  type TemplateProblem,
  type TemplateStep,
  type WorkflowTemplate,
} from './template'

export { firstMatching, matchesAny, matchesGlob } from './glob'

export {
  correctionFindings,
  isPathAllowed,
  reconcile,
  scopeRefusalFor,
  shouldHalt,
  summariseDiscrepancies,
  type ReconcileInput,
  type ReconcileResult,
} from './reconcile'

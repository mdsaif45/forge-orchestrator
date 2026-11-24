/**
 * @forge/runtimes — Universal agent runtime abstractions, ConPTY/POSIX process hosting,
 * CLI adapters, probes, environment sanitization, and quota limiters for Forge.
 */

// Process hosting & lifecycle
export {
  ProcessManager,
  rotateLogFile,
  type ProcessHandle,
  type ProcessManagerOptions,
  type ProcessMetrics,
  type ProcessOutcome,
  type ProcessOutcomeReason,
  type SpawnRequest,
} from './process/processManager'

export { isAlive, OrphanTracker, type OrphanReport, type TrackedProcess } from './process/orphans'

export {
  buildChildEnv,
  isSecretEnvName,
  REDACTION,
  redactOutput,
  stripAnsi,
  withheldEnvNames,
} from './process/redact'

export { accountEnv } from './process/accountEnv'

// Process runners (PTY & pipe)
export { createPtyProcessRunner, type PtyProcessRunnerOptions } from './ptyProcessRunner'
export { createPipeProcessRunner, type PipeProcessRunnerOptions } from './pipeProcessRunner'

// Universal runtime contracts & registry
export {
  IncapableRuntimeError,
  RuntimeRegistry,
  UnknownRuntimeError,
  runtimeDescription,
  runtimeExecutable,
  type RuntimeDescription,
} from './registry'

// Role bindings
export {
  AmbiguousRoleBindingError,
  bindRole,
  BindingSet,
  permits,
  requiredCapabilities,
  UnboundRoleError,
  type CreateBindingInput,
} from './bindings'

// Multi-turn exchange protocol
export { exchange, type ExchangeOutcome } from './exchange'

// Mock runtime & scenarios
export { MockAgentRuntime, type MockRuntimeOptions } from './mockRuntime'
export {
  SCENARIOS,
  scenarioSchema,
  type Scenario,
  type ScenarioFileEdit,
  type ScenarioName,
  type ScenarioStep,
} from './scenario'

// Concrete CLI adapters
export {
  ClaudeCliRuntime,
  type ClaudeCliRuntimeOptions,
  type ProcessRunner,
  type ProcessRunnerResult,
} from './claudeCliRuntime'
export { CustomCliRuntime, type CustomCliRuntimeOptions } from './customCliRuntime'
export { AntigravityCliRuntime, type AntigravityCliRuntimeOptions } from './antigravityCliRuntime'
export { GenericCliAgentRuntime, type GenericCliRuntimeOptions } from './genericCliRuntime'
export { HostedClaudeRuntime, type HostedClaudeRuntimeOptions } from './hostedClaudeRuntime'
export {
  HostedAntigravityRuntime,
  type HostedAntigravityRuntimeOptions,
} from './hostedAntigravityRuntime'
export { HostedSession, type HostedSessionOptions, type TurnOutcome } from './hostedSession'

// Diagnostics, probing & preflight
export {
  probeRuntimeExecutable,
  testRuntimeExecution,
  type RuntimeProbeResult,
  type RuntimeHealthStatus,
  type RuntimeExecutionTestResult,
} from './probe'
export {
  checkAntigravityPreflightRefusal,
  type AntigravityPreflightResult,
} from './antigravityPreflight'
export {
  detectInstalledClis,
  STANDARD_AGENT_CATALOG,
  loadCustomClis,
  saveCustomCli,
  removeCustomCli,
  loadAgentDefaults,
  saveAgentDefaults,
  setCustomCliStorePath,
  setAgentDefaultsStorePath,
  getCatalogClis,
  type InstalledCliInfo,
  type CustomCliConfig,
  type AgentDefaultsConfig,
  type StandardAgentInfo,
} from './cliDetector'
export {
  injectSkillsAndPrepareCli,
  type CliInjectionParams,
  type PreparedCliInvocation,
} from './cliSkillInjector'
export {
  isPromptReady,
  blockingPrompt,
  turnLooksComplete,
  promptKeystrokes,
} from './interactiveTurn'

// Security & governance
export {
  sanitizeRuntimeEnvironment,
  DEFAULT_ALLOWED_ENV_VARS,
  type SanitizeEnvironmentOptions,
  type SanitizedEnvironmentReport,
} from './environmentSanitizer'
export {
  auditRuntimeQuotas,
  createResourceBudget,
  DEFAULT_RESOURCE_BUDGET,
  evaluateProcessSample,
  generateMemoryFlags,
  type ProcessResourceSample,
  type ResourceAction,
  type ResourceBudgetConfig,
  type ResourceEvaluationResult,
  type RuntimeQuotaAuditReport,
} from './resourceLimiter'

export { ClaudeHookBridge, type HookEvent, type ClaudeHookBridgeOptions } from './claudeHooks'
export {
  type ClaudeRateLimitInfo,
  isClaudeRateLimitSpent,
  extractRateLimitInfo,
} from './claudeRateLimit'
export { claudeSessionId } from './claudeSession'
export { ClaudeTrustStore } from './claudeTrust'

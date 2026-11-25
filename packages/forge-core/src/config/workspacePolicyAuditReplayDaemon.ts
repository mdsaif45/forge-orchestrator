/**
 * CONFIG-031: Dynamic Workspace Policy Sandboxing and Audit Event Replay Daemon.
 *
 * Continuously and on-demand replays historical audit events against dynamically
 * updated workspace security policies (tool execution sandboxes, filesystem boundary
 * guards, network egress rules, credential restrictions) in bounded batches,
 * detecting policy regressions and emitting real-time compliance alerts (Axioms A1, A2, A7).
 */

import { createHash, randomUUID } from 'node:crypto'
import { validateToolExecutionPolicy, type ToolSandboxPolicy } from './toolSandboxPolicy'
import { validateWorkspaceBoundary } from './workspaceBoundaryGuard'

export type DaemonLifecycleState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED'

export type AuditReplaySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type AuditEventActionKind =
  'TOOL_EXEC' | 'FILE_ACCESS' | 'NETWORK_EGRESS' | 'CREDENTIAL_READ' | 'CONFIG_CHANGE'

export type PolicyRuleCategory =
  'TOOL_SANDBOX' | 'WORKSPACE_BOUNDARY' | 'NETWORK_EGRESS' | 'CREDENTIAL_ACCESS' | 'CONFIG_POLICY'

export interface HistoricalAuditEvent {
  readonly eventId: string
  readonly timestamp: number
  readonly actorId: string
  readonly actionKind: AuditEventActionKind
  readonly binary?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly targetPath?: string | undefined
  readonly networkHost?: string | undefined
  readonly secretKey?: string | undefined
  readonly originalDecision: 'ALLOWED' | 'BLOCKED'
  readonly policyRevision: string
  readonly metadata?: Record<string, unknown> | undefined
}

export interface PolicyReplaySpec {
  readonly specId: string
  readonly policyRevision: string
  readonly workspaceRoot: string
  readonly toolSandboxPolicy: ToolSandboxPolicy
  readonly blockedNetworkHosts?: readonly string[] | undefined
  readonly restrictedSecretKeys?: readonly string[] | undefined
  readonly enforceWorkspaceBoundary?: boolean | undefined
  readonly batchSize?: number | undefined
}

export interface AttestationViolation {
  readonly eventId: string
  readonly timestamp: number
  readonly actorId: string
  readonly actionKind: AuditEventActionKind
  readonly severity: AuditReplaySeverity
  readonly ruleCategory: PolicyRuleCategory
  readonly reason: string
  readonly remediationHint: string
}

export interface AttestationDiff {
  readonly diffId: string
  readonly eventId: string
  readonly actorId: string
  readonly actionKind: AuditEventActionKind
  readonly originalDecision: 'ALLOWED' | 'BLOCKED'
  readonly replayedDecision: 'ALLOWED' | 'BLOCKED'
  readonly regressionDetected: boolean
  readonly relaxedDetected: boolean
  readonly severity: AuditReplaySeverity
  readonly details: string
  readonly violation?: AttestationViolation | undefined
}

export interface ReplayBatchReport {
  readonly batchIndex: number
  readonly replayRunId: string
  readonly specId: string
  readonly policyRevision: string
  readonly eventsProcessed: number
  readonly compliantCount: number
  readonly violationsCount: number
  readonly regressionsCount: number
  readonly relaxedCount: number
  readonly diffs: readonly AttestationDiff[]
  readonly violations: readonly AttestationViolation[]
  readonly completedAt: number
}

export interface ReplayComplianceSummary {
  readonly replayRunId: string
  readonly specId: string
  readonly policyRevision: string
  readonly totalEventsReplayed: number
  readonly batchesProcessed: number
  readonly compliantEventsCount: number
  readonly violationsDetectedCount: number
  readonly newlyBlockedRegressionsCount: number
  readonly relaxedDecisionsCount: number
  readonly complianceRatePercent: number
  readonly overallStatus: 'CONFORMANT' | 'VIOLATIONS_DETECTED'
  readonly criticalViolationsCount: number
  readonly diffs: readonly AttestationDiff[]
  readonly violations: readonly AttestationViolation[]
  readonly attestationDigest: string
}

export interface DaemonStatusReport {
  readonly state: DaemonLifecycleState
  readonly activeSpecId: string
  readonly activePolicyRevision: string
  readonly intervalMs: number
  readonly totalCyclesExecuted: number
  readonly totalEventsReplayed: number
  readonly totalViolationsFlagged: number
  readonly cursorEventIndex: number
  readonly pendingEventsCount: number
  readonly lastReplayAt?: number | undefined
}

export type ComplianceAlertListener = (violation: AttestationViolation) => void

export class PolicyReplaySpecError extends Error {
  constructor(message: string) {
    super(`Invalid policy replay specification: ${message}`)
    this.name = 'PolicyReplaySpecError'
  }
}

export interface ReplayDaemonConfig {
  readonly initialSpec: PolicyReplaySpec
  readonly intervalMs?: number | undefined
}

function normalizeHost(rawHost: string): string {
  return rawHost.trim().toLowerCase().replace(/:\d+$/, '')
}

function matchesBlockedHost(host: string, blockedPatterns: readonly string[]): string | null {
  const normalized = normalizeHost(host)
  if (!normalized) return null

  for (const rawPattern of blockedPatterns) {
    const pattern = normalizeHost(rawPattern)
    if (!pattern) continue

    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // '.example.com'
      const bareDomain = pattern.slice(2)
      if (normalized === bareDomain || normalized.endsWith(suffix)) {
        return rawPattern
      }
    } else if (normalized === pattern) {
      return rawPattern
    }
  }
  return null
}

function validatePolicySpec(spec: PolicyReplaySpec): void {
  if (!spec.specId || spec.specId.trim().length === 0) {
    throw new PolicyReplaySpecError('specId cannot be empty')
  }
  if (!spec.policyRevision || spec.policyRevision.trim().length === 0) {
    throw new PolicyReplaySpecError('policyRevision cannot be empty')
  }
  if (spec.batchSize !== undefined && (!Number.isInteger(spec.batchSize) || spec.batchSize <= 0)) {
    throw new PolicyReplaySpecError(
      `batchSize must be a positive integer, got ${String(spec.batchSize)}`,
    )
  }
}

function evaluateSingleEventAgainstSpec(
  event: HistoricalAuditEvent,
  spec: PolicyReplaySpec,
): {
  readonly allowed: boolean
  readonly ruleCategory: PolicyRuleCategory
  readonly severity: AuditReplaySeverity
  readonly reason: string
  readonly remediationHint: string
} {
  if (event.actionKind === 'TOOL_EXEC') {
    const binary = event.binary ?? ''
    const check = validateToolExecutionPolicy(binary, event.args ?? [], spec.toolSandboxPolicy)
    if (!check.allowed) {
      return {
        allowed: false,
        ruleCategory: 'TOOL_SANDBOX',
        severity: check.violationKind === 'forbidden_binary' ? 'CRITICAL' : 'HIGH',
        reason: check.reason ?? check.formattedSummary,
        remediationHint: `Revoke or restrict binary '${check.binary}' in actor '${event.actorId}' sandbox profile.`,
      }
    }
    return {
      allowed: true,
      ruleCategory: 'TOOL_SANDBOX',
      severity: 'INFO',
      reason: `Tool execution '${check.binary}' conforms to sandbox policy rev ${spec.policyRevision}.`,
      remediationHint: '',
    }
  }

  if (event.actionKind === 'FILE_ACCESS') {
    if (spec.enforceWorkspaceBoundary !== false) {
      const boundaryCheck = validateWorkspaceBoundary(event.targetPath ?? '', spec.workspaceRoot)
      if (!boundaryCheck.allowed) {
        return {
          allowed: false,
          ruleCategory: 'WORKSPACE_BOUNDARY',
          severity:
            boundaryCheck.violationKind === 'system_path' ||
            boundaryCheck.violationKind === 'traversal_escape'
              ? 'CRITICAL'
              : 'HIGH',
          reason: boundaryCheck.reason ?? boundaryCheck.formattedSummary,
          remediationHint: `Audit writes outside '${spec.workspaceRoot}' by '${event.actorId}' and quarantine affected artifacts.`,
        }
      }
    }
    return {
      allowed: true,
      ruleCategory: 'WORKSPACE_BOUNDARY',
      severity: 'INFO',
      reason: `Filesystem access '${event.targetPath ?? ''}' stays within workspace boundary.`,
      remediationHint: '',
    }
  }

  if (event.actionKind === 'NETWORK_EGRESS') {
    const blockedHosts = spec.blockedNetworkHosts ?? []
    const matched = matchesBlockedHost(event.networkHost ?? '', blockedHosts)
    if (matched !== null) {
      return {
        allowed: false,
        ruleCategory: 'NETWORK_EGRESS',
        severity: 'HIGH',
        reason: `Network egress to host '${event.networkHost ?? ''}' violates blocked host rule '${matched}'.`,
        remediationHint: `Block outbound egress to '${matched}' in workspace capability firewall.`,
      }
    }
    return {
      allowed: true,
      ruleCategory: 'NETWORK_EGRESS',
      severity: 'INFO',
      reason: `Network egress host '${event.networkHost ?? 'none'}' permitted under rev ${spec.policyRevision}.`,
      remediationHint: '',
    }
  }

  if (event.actionKind === 'CREDENTIAL_READ') {
    const restrictedKeys = new Set(
      (spec.restrictedSecretKeys ?? []).map((k) => k.trim().toUpperCase()),
    )
    const normalizedKey = (event.secretKey ?? '').trim().toUpperCase()
    if (normalizedKey.length > 0 && restrictedKeys.has(normalizedKey)) {
      return {
        allowed: false,
        ruleCategory: 'CREDENTIAL_ACCESS',
        severity: 'CRITICAL',
        reason: `Historical read of restricted secret '${event.secretKey ?? ''}' violates credential policy rev ${spec.policyRevision}.`,
        remediationHint: `Rotate secret '${event.secretKey ?? ''}' via forge config secret-lifecycle and revoke actor lease.`,
      }
    }
    return {
      allowed: true,
      ruleCategory: 'CREDENTIAL_ACCESS',
      severity: 'INFO',
      reason: `Credential access conforms to secret restriction rules.`,
      remediationHint: '',
    }
  }

  // CONFIG_CHANGE
  return {
    allowed: true,
    ruleCategory: 'CONFIG_POLICY',
    severity: 'LOW',
    reason: `Configuration transition recorded under policy rev ${event.policyRevision}.`,
    remediationHint: '',
  }
}

export class WorkspacePolicyAuditReplayDaemon {
  private activeSpec: PolicyReplaySpec
  private readonly intervalMs: number
  private state: DaemonLifecycleState = 'IDLE'

  private readonly eventLog: HistoricalAuditEvent[] = []
  private readonly specHistory: PolicyReplaySpec[] = []
  private readonly listeners = new Set<ComplianceAlertListener>()
  private timerHandle: ReturnType<typeof setInterval> | null = null

  private cursorEventIndex = 0
  private batchCounter = 0
  private totalCyclesExecuted = 0
  private totalEventsReplayed = 0
  private totalViolationsFlagged = 0
  private lastReplayAt?: number | undefined

  constructor(config: ReplayDaemonConfig) {
    validatePolicySpec(config.initialSpec)
    const intervalMs = config.intervalMs ?? 5000
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new PolicyReplaySpecError(`intervalMs must be > 0, got ${String(intervalMs)}`)
    }
    this.activeSpec = config.initialSpec
    this.intervalMs = intervalMs
    this.specHistory.push(config.initialSpec)
  }

  onViolationAlert(listener: ComplianceAlertListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ingestEvents(events: readonly HistoricalAuditEvent[]): number {
    for (const ev of events) {
      this.eventLog.push(ev)
    }
    return this.eventLog.length
  }

  /**
   * Dynamically replaces the workspace sandbox & security policy specification and resets
   * the replay cursor to index 0 so historical audit events are re-attested against new rules.
   */
  updatePolicySpec(nextSpec: PolicyReplaySpec): void {
    validatePolicySpec(nextSpec)
    this.activeSpec = nextSpec
    this.specHistory.push(nextSpec)
    this.cursorEventIndex = 0
  }

  getSpecHistory(): readonly PolicyReplaySpec[] {
    return [...this.specHistory]
  }

  start(): void {
    if (this.state === 'RUNNING') return
    this.state = 'RUNNING'
    this.timerHandle = setInterval(() => {
      if (this.state === 'RUNNING') {
        this.replayNextBatch()
      }
    }, this.intervalMs)
    this.timerHandle.unref()
  }

  pause(): void {
    if (this.state === 'RUNNING') {
      this.state = 'PAUSED'
    }
  }

  resume(): void {
    if (this.state === 'PAUSED') {
      this.state = 'RUNNING'
    }
  }

  stop(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle)
      this.timerHandle = null
    }
    this.state = 'STOPPED'
  }

  /**
   * Replays the next batch of historical audit events starting from `cursorEventIndex`.
   */
  replayNextBatch(replayRunId = `replay-${randomUUID().slice(0, 8)}`): ReplayBatchReport {
    const batchSize = this.activeSpec.batchSize ?? 50
    const sliceEnd = Math.min(this.cursorEventIndex + batchSize, this.eventLog.length)
    const slice = this.eventLog.slice(this.cursorEventIndex, sliceEnd)

    const diffs: AttestationDiff[] = []
    const violations: AttestationViolation[] = []
    let compliantCount = 0
    let regressionsCount = 0
    let relaxedCount = 0

    for (const event of slice) {
      const outcome = evaluateSingleEventAgainstSpec(event, this.activeSpec)
      const replayedDecision: 'ALLOWED' | 'BLOCKED' = outcome.allowed ? 'ALLOWED' : 'BLOCKED'
      const regressionDetected =
        event.originalDecision === 'ALLOWED' && replayedDecision === 'BLOCKED'
      const relaxedDetected = event.originalDecision === 'BLOCKED' && replayedDecision === 'ALLOWED'

      let violation: AttestationViolation | undefined
      if (!outcome.allowed) {
        violation = {
          eventId: event.eventId,
          timestamp: event.timestamp,
          actorId: event.actorId,
          actionKind: event.actionKind,
          severity: outcome.severity,
          ruleCategory: outcome.ruleCategory,
          reason: outcome.reason,
          remediationHint: outcome.remediationHint,
        }
        violations.push(violation)
        this.totalViolationsFlagged += 1
        for (const listener of this.listeners) {
          listener(violation)
        }
      } else {
        compliantCount += 1
      }

      if (regressionDetected) regressionsCount += 1
      if (relaxedDetected) relaxedCount += 1

      diffs.push({
        diffId: `adiff-${event.eventId}`,
        eventId: event.eventId,
        actorId: event.actorId,
        actionKind: event.actionKind,
        originalDecision: event.originalDecision,
        replayedDecision,
        regressionDetected,
        relaxedDetected,
        severity: outcome.severity,
        details: outcome.reason,
        ...(violation !== undefined ? { violation } : {}),
      })
    }

    this.cursorEventIndex = sliceEnd
    this.totalEventsReplayed += slice.length
    this.totalCyclesExecuted += 1
    this.batchCounter += 1
    const completedAt = Date.now()
    this.lastReplayAt = completedAt

    return {
      batchIndex: this.batchCounter,
      replayRunId,
      specId: this.activeSpec.specId,
      policyRevision: this.activeSpec.policyRevision,
      eventsProcessed: slice.length,
      compliantCount,
      violationsCount: violations.length,
      regressionsCount,
      relaxedCount,
      diffs,
      violations,
      completedAt,
    }
  }

  /**
   * Replays all remaining (or full log if `fromStart: true`) events in batches and produces
   * a signed compliance attestation report.
   */
  replayAll(options?: {
    readonly fromStart?: boolean | undefined
    readonly replayRunId?: string | undefined
  }): ReplayComplianceSummary {
    if (options?.fromStart) {
      this.cursorEventIndex = 0
    }

    const replayRunId = options?.replayRunId ?? `replay-${randomUUID().slice(0, 8)}`
    const allDiffs: AttestationDiff[] = []
    const allViolations: AttestationViolation[] = []
    let batchesProcessed = 0
    let compliantEventsCount = 0
    let newlyBlockedRegressionsCount = 0
    let relaxedDecisionsCount = 0

    while (this.cursorEventIndex < this.eventLog.length) {
      const batch = this.replayNextBatch(replayRunId)
      batchesProcessed += 1
      compliantEventsCount += batch.compliantCount
      newlyBlockedRegressionsCount += batch.regressionsCount
      relaxedDecisionsCount += batch.relaxedCount
      allDiffs.push(...batch.diffs)
      allViolations.push(...batch.violations)
    }

    const totalEventsReplayed = allDiffs.length
    const complianceRatePercent =
      totalEventsReplayed > 0
        ? Number(((compliantEventsCount / totalEventsReplayed) * 100).toFixed(2))
        : 100

    const criticalViolationsCount = allViolations.filter((v) => v.severity === 'CRITICAL').length
    const overallStatus: ReplayComplianceSummary['overallStatus'] =
      allViolations.length === 0 ? 'CONFORMANT' : 'VIOLATIONS_DETECTED'

    const digestPayload = [
      replayRunId,
      this.activeSpec.specId,
      this.activeSpec.policyRevision,
      String(totalEventsReplayed),
      String(compliantEventsCount),
      allViolations.map((v) => `${v.eventId}:${v.ruleCategory}:${v.severity}`).join('|'),
    ].join(':')

    const attestationDigest = createHash('sha256').update(digestPayload, 'utf8').digest('hex')

    return {
      replayRunId,
      specId: this.activeSpec.specId,
      policyRevision: this.activeSpec.policyRevision,
      totalEventsReplayed,
      batchesProcessed,
      compliantEventsCount,
      violationsDetectedCount: allViolations.length,
      newlyBlockedRegressionsCount,
      relaxedDecisionsCount,
      complianceRatePercent,
      overallStatus,
      criticalViolationsCount,
      diffs: allDiffs,
      violations: allViolations,
      attestationDigest,
    }
  }

  getStatusReport(): DaemonStatusReport {
    return {
      state: this.state,
      activeSpecId: this.activeSpec.specId,
      activePolicyRevision: this.activeSpec.policyRevision,
      intervalMs: this.intervalMs,
      totalCyclesExecuted: this.totalCyclesExecuted,
      totalEventsReplayed: this.totalEventsReplayed,
      totalViolationsFlagged: this.totalViolationsFlagged,
      cursorEventIndex: this.cursorEventIndex,
      pendingEventsCount: Math.max(0, this.eventLog.length - this.cursorEventIndex),
      lastReplayAt: this.lastReplayAt,
    }
  }
}

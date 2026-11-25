/**
 * CONFIG-030: Workspace capability emergency revocation tripwire and sandbox killswitch.
 *
 * Provides a fail-closed circuit breaker that instantly revokes tool execution,
 * filesystem write, or network access capabilities across running subagents upon
 * detection of anomalous, unauthorized, or malicious operations (Axioms A1, A4, A7).
 */

export type CapabilityKind =
  'FILE_WRITE' | 'TOOL_EXEC' | 'NETWORK_EGRESS' | 'SECRET_ACCESS' | 'PROCESS_SPAWN'

export type KillswitchState = 'ACTIVE_NOMINAL' | 'TRIPPED_GLOBAL' | 'TRIPPED_TARGETED' | 'DISARMED'

export type TripwireTriggerReason =
  | 'ANOMALOUS_FILE_MODIFICATION'
  | 'UNAUTHORIZED_OUTBOUND_EGRESS'
  | 'SECRET_LEAK_ATTEMPT'
  | 'ESCAPE_SANDBOX_PROBE'
  | 'MANUAL_OPERATOR_KILLSWITCH'
  | 'POLICY_VIOLATION_THRESHOLD'

export type TriggerSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM'

export interface CapabilityLease {
  readonly leaseId: string
  readonly subagentId: string
  readonly capability: CapabilityKind
  readonly grantedAt: number
  readonly expiresAt: number
  readonly isRevoked: boolean
}

export interface TripwireTrigger {
  readonly reason: TripwireTriggerReason
  readonly severity: TriggerSeverity
  readonly sourceSubagentId?: string | undefined
  readonly targetCapabilities?: readonly CapabilityKind[] | undefined
  readonly details?: string | undefined
  readonly triggeredBy?: string | undefined
}

export interface RevocationScope {
  readonly isGlobal: boolean
  readonly targetSubagentIds?: readonly string[] | undefined
  readonly targetCapabilities?: readonly CapabilityKind[] | undefined
}

export interface CapabilityRevocationAuditEntry {
  readonly auditId: string
  readonly timestamp: number
  readonly previousState: KillswitchState
  readonly newState: KillswitchState
  readonly trigger: TripwireTrigger
  readonly scope: RevocationScope
  readonly revokedLeasesCount: number
  readonly affectedSubagents: readonly string[]
  readonly explanation: string
}

export interface TripwireConfig {
  readonly autoTripOnCritical?: boolean | undefined
  readonly defaultLeaseTtlMs?: number | undefined
}

export interface TripwireStatusReport {
  readonly state: KillswitchState
  readonly activeLeasesCount: number
  readonly revokedLeasesCount: number
  readonly totalAuditEntries: number
  readonly targetedRevocationsCount: number
  readonly recentAudit: readonly CapabilityRevocationAuditEntry[]
}

export type RevocationListener = (entry: CapabilityRevocationAuditEntry) => void

export class WorkspaceCapabilityRevocationTripwire {
  private state: KillswitchState = 'ACTIVE_NOMINAL'
  private readonly leases = new Map<string, CapabilityLease>()
  private readonly targetedBlockedAgents = new Set<string>()
  private readonly targetedCapabilityBlocks = new Map<string, Set<CapabilityKind>>()
  private readonly auditLog: CapabilityRevocationAuditEntry[] = []
  private readonly listeners = new Set<RevocationListener>()

  private readonly defaultLeaseTtlMs: number
  private instanceCounter = 0

  constructor(config: TripwireConfig = {}) {
    this.defaultLeaseTtlMs = config.defaultLeaseTtlMs ?? 60_000
  }

  /**
   * Returns current killswitch state.
   */
  getState(): KillswitchState {
    return this.state
  }

  /**
   * Issues a time-bounded capability lease to a subagent unless tripwire is active.
   */
  grantLease(subagentId: string, capability: CapabilityKind, ttlMs?: number): CapabilityLease {
    if (!subagentId || subagentId.trim().length === 0) {
      throw new Error('subagentId cannot be empty')
    }

    this.instanceCounter += 1
    const leaseId = `lease-${subagentId}-${String(Date.now())}-${String(this.instanceCounter)}`
    const now = Date.now()
    const expiresAt = now + Math.max(1000, ttlMs ?? this.defaultLeaseTtlMs)

    // Check if tripwire blocks this capability
    const isAllowed = this.checkCapability(subagentId, capability)
    const lease: CapabilityLease = {
      leaseId,
      subagentId,
      capability,
      grantedAt: now,
      expiresAt,
      isRevoked: !isAllowed,
    }

    this.leases.set(leaseId, lease)
    return lease
  }

  /**
   * Validates whether a subagent currently has permission to exercise a capability.
   */
  checkCapability(subagentId: string, capability: CapabilityKind): boolean {
    if (this.state === 'TRIPPED_GLOBAL') {
      return false
    }

    if (this.state === 'DISARMED') {
      return true
    }

    // Targeted agent block
    if (this.targetedBlockedAgents.has(subagentId)) {
      return false
    }

    // Targeted subagent capability block
    const blockedCaps = this.targetedCapabilityBlocks.get(subagentId)
    if (blockedCaps?.has(capability)) {
      return false
    }

    return true
  }

  /**
   * Emergency trigger: atomically trips the killswitch, revokes active capability leases,
   * emits an emergency broadcast, and persists an audit log entry.
   */
  triggerEmergencyKillswitch(trigger: TripwireTrigger): CapabilityRevocationAuditEntry {
    const previousState = this.state
    const isGlobal =
      trigger.severity === 'CRITICAL' ||
      trigger.sourceSubagentId === undefined ||
      trigger.sourceSubagentId === '*'

    const newState: KillswitchState = isGlobal ? 'TRIPPED_GLOBAL' : 'TRIPPED_TARGETED'
    this.state = newState

    const affectedSubagentsSet = new Set<string>()
    let revokedLeasesCount = 0

    if (isGlobal) {
      // Invalidate all leases
      for (const [id, lease] of this.leases.entries()) {
        if (!lease.isRevoked) {
          this.leases.set(id, { ...lease, isRevoked: true })
          affectedSubagentsSet.add(lease.subagentId)
          revokedLeasesCount += 1
        }
      }
    } else {
      const targetSubagent = trigger.sourceSubagentId ?? 'unknown'
      affectedSubagentsSet.add(targetSubagent)

      if (trigger.targetCapabilities && trigger.targetCapabilities.length > 0) {
        let set = this.targetedCapabilityBlocks.get(targetSubagent)
        if (!set) {
          set = new Set()
          this.targetedCapabilityBlocks.set(targetSubagent, set)
        }
        for (const cap of trigger.targetCapabilities) {
          set.add(cap)
        }
      } else {
        this.targetedBlockedAgents.add(targetSubagent)
      }

      // Invalidate relevant leases
      for (const [id, lease] of this.leases.entries()) {
        if (lease.subagentId === targetSubagent && !lease.isRevoked) {
          if (
            !trigger.targetCapabilities ||
            trigger.targetCapabilities.length === 0 ||
            trigger.targetCapabilities.includes(lease.capability)
          ) {
            this.leases.set(id, { ...lease, isRevoked: true })
            revokedLeasesCount += 1
          }
        }
      }
    }

    const affectedSubagents = Array.from(affectedSubagentsSet)
    const scope: RevocationScope = {
      isGlobal,
      targetSubagentIds:
        isGlobal || !trigger.sourceSubagentId ? undefined : [trigger.sourceSubagentId],
      targetCapabilities: trigger.targetCapabilities,
    }

    const auditId = `audit-tripwire-${String(Date.now())}-${String(this.auditLog.length + 1)}`
    const explanation = isGlobal
      ? `Global killswitch engaged due to ${trigger.reason} (${trigger.severity}). All active capability leases revoked.`
      : `Targeted capability revocation enforced for subagent "${trigger.sourceSubagentId ?? 'unknown'}" (${trigger.reason}).`

    const auditEntry: CapabilityRevocationAuditEntry = {
      auditId,
      timestamp: Date.now(),
      previousState,
      newState,
      trigger: { ...trigger },
      scope,
      revokedLeasesCount,
      affectedSubagents,
      explanation,
    }

    this.auditLog.push(auditEntry)

    // Broadcast to listeners with safety boundary
    for (const listener of this.listeners) {
      try {
        listener(auditEntry)
      } catch {
        // Listener errors are safely isolated
      }
    }

    return auditEntry
  }

  /**
   * Reinstates a specifically targeted subagent once remediation or human authorization completes.
   */
  reinstateSubagent(subagentId: string, operatorReason: string): boolean {
    if (this.state === 'TRIPPED_GLOBAL') {
      return false
    }

    const hadAgentBlock = this.targetedBlockedAgents.delete(subagentId)
    const hadCapBlock = this.targetedCapabilityBlocks.delete(subagentId)

    if (hadAgentBlock || hadCapBlock) {
      if (this.targetedBlockedAgents.size === 0 && this.targetedCapabilityBlocks.size === 0) {
        this.state = 'ACTIVE_NOMINAL'
      }

      this.auditLog.push({
        auditId: `audit-reinstate-${String(Date.now())}`,
        timestamp: Date.now(),
        previousState: this.state,
        newState: this.state,
        trigger: {
          reason: 'MANUAL_OPERATOR_KILLSWITCH',
          severity: 'MEDIUM',
          sourceSubagentId: subagentId,
          details: `Subagent reinstated: ${operatorReason}`,
        },
        scope: { isGlobal: false, targetSubagentIds: [subagentId] },
        revokedLeasesCount: 0,
        affectedSubagents: [subagentId],
        explanation: `Subagent "${subagentId}" reinstated by operator: ${operatorReason}`,
      })
      return true
    }

    return false
  }

  /**
   * Resets the entire tripwire back to ACTIVE_NOMINAL state.
   */
  resetNominal(operatorKey: string): boolean {
    if (!operatorKey || operatorKey.trim().length === 0) {
      throw new Error('Operator authorization key required to disengage killswitch')
    }

    const previousState = this.state
    this.state = 'ACTIVE_NOMINAL'
    this.targetedBlockedAgents.clear()
    this.targetedCapabilityBlocks.clear()

    this.auditLog.push({
      auditId: `audit-reset-${String(Date.now())}`,
      timestamp: Date.now(),
      previousState,
      newState: 'ACTIVE_NOMINAL',
      trigger: {
        reason: 'MANUAL_OPERATOR_KILLSWITCH',
        severity: 'MEDIUM',
        details: `Tripwire reset to ACTIVE_NOMINAL with key ${operatorKey.slice(0, 4)}...`,
      },
      scope: { isGlobal: true },
      revokedLeasesCount: 0,
      affectedSubagents: [],
      explanation: 'Tripwire fully reset to ACTIVE_NOMINAL status by operator.',
    })

    return true
  }

  /**
   * Subscribes to emergency capability revocation events.
   */
  onRevocation(listener: RevocationListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Returns complete audit trail history.
   */
  getAuditHistory(): readonly CapabilityRevocationAuditEntry[] {
    return [...this.auditLog]
  }

  /**
   * Returns a comprehensive status report.
   */
  getStatusReport(): TripwireStatusReport {
    let activeLeasesCount = 0
    let revokedLeasesCount = 0

    for (const lease of this.leases.values()) {
      if (lease.isRevoked) {
        revokedLeasesCount += 1
      } else {
        activeLeasesCount += 1
      }
    }

    return {
      state: this.state,
      activeLeasesCount,
      revokedLeasesCount,
      totalAuditEntries: this.auditLog.length,
      targetedRevocationsCount:
        this.targetedBlockedAgents.size + this.targetedCapabilityBlocks.size,
      recentAudit: this.auditLog.slice(-5),
    }
  }
}

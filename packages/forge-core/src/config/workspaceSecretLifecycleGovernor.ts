import { randomUUID } from 'node:crypto'

/**
 * Workspace secret lifecycle audit trail and automated rotation governor.
 *
 * Implements staged dual-key rotation phases, grace period enforcement,
 * proactive expiration auditing, and access telemetry logging (A1, A7).
 */

export type SecretLifecycleState = 'active' | 'in_rotation' | 'deprecated' | 'revoked'

export interface RotationPolicy {
  /** Maximum lifetime in milliseconds before rotation is required. Defaults to 30 days (2,592,000,000ms). */
  readonly maxLifetimeMs: number
  /** Grace period in milliseconds where previous key remains valid alongside new key. Defaults to 3 days (259,200,000ms). */
  readonly gracePeriodMs: number
  /** Proactive warning window in milliseconds before rotation is due. Defaults to 7 days (604,800,000ms). */
  readonly warningThresholdMs: number
}

export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  gracePeriodMs: 3 * 24 * 60 * 60 * 1000,
  warningThresholdMs: 7 * 24 * 60 * 60 * 1000,
}

export interface SecretLifecycleRecord {
  readonly secretId: string
  readonly secretName: string
  readonly currentVersion: number
  readonly previousVersion?: number | undefined
  state: SecretLifecycleState
  readonly createdAt: number
  rotationDueAt: number
  revocationDueAt?: number | undefined
  lastAccessedAt: number
  accessCount: number
  policy: RotationPolicy
  revocationReason?: string | undefined
}

export interface SecretAccessAuditEntry {
  readonly auditId: string
  readonly secretName: string
  readonly requestedVersion: number
  readonly allowed: boolean
  readonly state: SecretLifecycleState
  readonly caller: string
  readonly timestamp: number
  readonly reason: string
}

export interface SecretAccessDecision {
  readonly allowed: boolean
  readonly secretName: string
  readonly version: number
  readonly state: SecretLifecycleState
  readonly reason: string
  readonly rotationRequired: boolean
}

export interface LifecycleAuditSummary {
  readonly totalSecrets: number
  readonly activeCount: number
  readonly inRotationCount: number
  readonly deprecatedCount: number
  readonly revokedCount: number
  readonly upcomingRotationsCount: number
  readonly violationsCount: number
  readonly records: readonly {
    readonly secretName: string
    readonly state: SecretLifecycleState
    readonly version: number
    readonly daysUntilDue: number
  }[]
}

export class WorkspaceSecretLifecycleGovernor {
  private readonly secrets = new Map<string, SecretLifecycleRecord>()
  private readonly auditLog: SecretAccessAuditEntry[] = []
  private readonly maxAuditHistory: number

  constructor(maxAuditHistory = 1000) {
    this.maxAuditHistory = Math.max(50, maxAuditHistory)
  }

  /**
   * Registers a new secret under lifecycle governance.
   */
  registerSecret(
    secretName: string,
    policy: Partial<RotationPolicy> = {},
    now: number = Date.now(),
  ): SecretLifecycleRecord {
    if (this.secrets.has(secretName)) {
      throw new Error(`Secret ${secretName} already registered under lifecycle governance`)
    }

    const effectivePolicy: RotationPolicy = {
      maxLifetimeMs: Math.max(100, policy.maxLifetimeMs ?? DEFAULT_ROTATION_POLICY.maxLifetimeMs),
      gracePeriodMs: Math.max(50, policy.gracePeriodMs ?? DEFAULT_ROTATION_POLICY.gracePeriodMs),
      warningThresholdMs: Math.max(
        50,
        policy.warningThresholdMs ?? DEFAULT_ROTATION_POLICY.warningThresholdMs,
      ),
    }

    const record: SecretLifecycleRecord = {
      secretId: randomUUID(),
      secretName,
      currentVersion: 1,
      state: 'active',
      createdAt: now,
      rotationDueAt: now + effectivePolicy.maxLifetimeMs,
      lastAccessedAt: now,
      accessCount: 0,
      policy: effectivePolicy,
    }

    this.secrets.set(secretName, record)
    return record
  }

  /**
   * Initiates staged dual-key rotation. Increments version and enters grace period.
   */
  startRotation(secretName: string, now: number = Date.now()): SecretLifecycleRecord {
    const record = this.secrets.get(secretName)
    if (!record) {
      throw new Error(`Secret ${secretName} not found in lifecycle registry`)
    }

    if (record.state === 'revoked') {
      throw new Error(`Cannot rotate revoked secret ${secretName}`)
    }

    const previousVersion = record.currentVersion
    const currentVersion = previousVersion + 1

    const updated: SecretLifecycleRecord = {
      ...record,
      currentVersion,
      previousVersion,
      state: 'in_rotation',
      rotationDueAt: now + record.policy.maxLifetimeMs,
      revocationDueAt: now + record.policy.gracePeriodMs,
      lastAccessedAt: now,
    }

    this.secrets.set(secretName, updated)
    return updated
  }

  /**
   * Completes staged rotation, retiring previous version into revocation.
   */
  completeRotation(secretName: string, now: number = Date.now()): SecretLifecycleRecord {
    const record = this.secrets.get(secretName)
    if (!record) {
      throw new Error(`Secret ${secretName} not found in lifecycle registry`)
    }

    const updated: SecretLifecycleRecord = {
      ...record,
      previousVersion: undefined,
      revocationDueAt: undefined,
      state: 'active',
      lastAccessedAt: now,
    }

    this.secrets.set(secretName, updated)
    return updated
  }

  /**
   * Hard-revokes a secret fail-closed across all versions.
   */
  revokeSecret(
    secretName: string,
    reason: string,
    now: number = Date.now(),
  ): SecretLifecycleRecord {
    const record = this.secrets.get(secretName)
    if (!record) {
      throw new Error(`Secret ${secretName} not found in lifecycle registry`)
    }

    const updated: SecretLifecycleRecord = {
      ...record,
      state: 'revoked',
      revocationReason: reason,
      lastAccessedAt: now,
    }

    this.secrets.set(secretName, updated)
    return updated
  }

  /**
   * Evaluates whether an access request to a secret version is permissible.
   */
  evaluateAccess(
    secretName: string,
    requestedVersion: number,
    caller: string,
    now: number = Date.now(),
  ): SecretAccessDecision {
    const record = this.secrets.get(secretName)
    if (!record) {
      this.recordAudit(
        secretName,
        requestedVersion,
        false,
        'revoked',
        caller,
        now,
        'Secret not registered',
      )
      return {
        allowed: false,
        secretName,
        version: requestedVersion,
        state: 'revoked',
        reason: 'Secret not registered',
        rotationRequired: false,
      }
    }

    // Check if secret was hard-revoked
    if (record.state === 'revoked') {
      this.recordAudit(
        secretName,
        requestedVersion,
        false,
        'revoked',
        caller,
        now,
        record.revocationReason ?? 'Secret is revoked',
      )
      return {
        allowed: false,
        secretName,
        version: requestedVersion,
        state: 'revoked',
        reason: record.revocationReason ?? 'Secret is revoked',
        rotationRequired: false,
      }
    }

    // Check automatic expiration / deprecation transition
    if (now >= record.rotationDueAt && record.state === 'active') {
      record.state = 'deprecated'
    }

    // Check if in_rotation grace period has lapsed for old version
    if (
      record.state === 'in_rotation' &&
      record.revocationDueAt !== undefined &&
      now >= record.revocationDueAt
    ) {
      const updatedRecord: SecretLifecycleRecord = {
        ...record,
        previousVersion: undefined,
        revocationDueAt: undefined,
        state: 'active',
      }
      this.secrets.set(secretName, updatedRecord)
      return this.evaluateAccess(secretName, requestedVersion, caller, now)
    }

    const isCurrentVersion = requestedVersion === record.currentVersion
    const isGraceVersion =
      record.state === 'in_rotation' && requestedVersion === record.previousVersion

    if (!isCurrentVersion && !isGraceVersion) {
      const reason = `Version ${String(requestedVersion)} is retired; active version is ${String(record.currentVersion)}`
      this.recordAudit(secretName, requestedVersion, false, record.state, caller, now, reason)
      return {
        allowed: false,
        secretName,
        version: requestedVersion,
        state: record.state,
        reason,
        rotationRequired: false,
      }
    }

    record.accessCount += 1
    record.lastAccessedAt = now

    const rotationRequired =
      record.state === 'deprecated' ||
      now >= record.rotationDueAt - record.policy.warningThresholdMs

    this.recordAudit(
      secretName,
      requestedVersion,
      true,
      record.state,
      caller,
      now,
      'Authorized access',
    )

    return {
      allowed: true,
      secretName,
      version: requestedVersion,
      state: record.state,
      reason: 'Access granted',
      rotationRequired,
    }
  }

  /**
   * Generates a forensic lifecycle audit report across all registered secrets.
   */
  auditLifecycle(now: number = Date.now()): LifecycleAuditSummary {
    let active = 0
    let inRotation = 0
    let deprecated = 0
    let revoked = 0
    let upcoming = 0
    let violations = 0

    const recordList: {
      secretName: string
      state: SecretLifecycleState
      version: number
      daysUntilDue: number
    }[] = []

    for (const record of this.secrets.values()) {
      // Auto-update deprecated status if past due
      if (now >= record.rotationDueAt && record.state === 'active') {
        record.state = 'deprecated'
      }

      if (record.state === 'active') active += 1
      else if (record.state === 'in_rotation') inRotation += 1
      else if (record.state === 'deprecated') {
        deprecated += 1
        violations += 1
      } else {
        revoked += 1
      }

      const msUntilDue = record.rotationDueAt - now
      const daysUntilDue = Math.round(msUntilDue / (24 * 60 * 60 * 1000))

      if (
        msUntilDue > 0 &&
        msUntilDue <= record.policy.warningThresholdMs &&
        record.state === 'active'
      ) {
        upcoming += 1
      }

      recordList.push({
        secretName: record.secretName,
        state: record.state,
        version: record.currentVersion,
        daysUntilDue,
      })
    }

    return {
      totalSecrets: this.secrets.size,
      activeCount: active,
      inRotationCount: inRotation,
      deprecatedCount: deprecated,
      revokedCount: revoked,
      upcomingRotationsCount: upcoming,
      violationsCount: violations,
      records: recordList,
    }
  }

  getSecret(secretName: string): SecretLifecycleRecord | null {
    return this.secrets.get(secretName) ?? null
  }

  getAuditLog(): readonly SecretAccessAuditEntry[] {
    return this.auditLog
  }

  private recordAudit(
    secretName: string,
    requestedVersion: number,
    allowed: boolean,
    state: SecretLifecycleState,
    caller: string,
    timestamp: number,
    reason: string,
  ): void {
    this.auditLog.push({
      auditId: randomUUID(),
      secretName,
      requestedVersion,
      allowed,
      state,
      caller,
      timestamp,
      reason,
    })

    if (this.auditLog.length > this.maxAuditHistory) {
      this.auditLog.shift()
    }
  }
}

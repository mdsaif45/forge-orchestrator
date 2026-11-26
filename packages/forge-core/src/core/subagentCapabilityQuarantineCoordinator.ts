import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

export type SubagentCapability =
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'PROCESS_SPAWN'
  | 'NETWORK_EGRESS'
  | 'GIT_MUTATE'
  | 'DB_WRITE'
  | 'SECRET_ACCESS'

export type QuarantineZone = 'STRICT' | 'SANDBOXED' | 'ELEVATED' | 'QUARANTINED'

export type LeaseStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'QUARANTINED'

export type LeaseRenewalStatus =
  | 'RENEWED'
  | 'DENIED_NOT_FOUND'
  | 'DENIED_EXPIRED'
  | 'DENIED_REVOKED'
  | 'DENIED_QUARANTINED'
  | 'DENIED_MAX_RENEWALS'
  | 'DENIED_INSUFFICIENT_PROGRESS'
  | 'DENIED_INVALID_ATTESTATION'

export interface QuarantinePolicy {
  readonly defaultLeaseTtlMs: number
  readonly maxLeaseTtlMs: number
  readonly maxRenewals: number
  readonly minProgressDeltaPerRenewal: number
  readonly allowedCapabilitiesByZone: Readonly<
    Record<QuarantineZone, readonly SubagentCapability[]>
  >
  readonly requireAttestationDigest: boolean
  readonly enableExpirationTimers: boolean
}

export interface IssueLeaseRequest {
  readonly subagentId: string
  readonly zone?: QuarantineZone | undefined
  readonly requestedCapabilities: readonly SubagentCapability[]
  readonly allowedPaths?: readonly string[] | undefined
  readonly ttlMs?: number | undefined
  readonly maxRenewals?: number | undefined
  readonly initialProgressScore?: number | undefined
}

export interface SubagentLease {
  readonly leaseId: string
  readonly subagentId: string
  readonly zone: QuarantineZone
  readonly status: LeaseStatus
  readonly grantedCapabilities: readonly SubagentCapability[]
  readonly deniedCapabilities: readonly SubagentCapability[]
  readonly allowedPaths: readonly string[]
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly lastRenewedAtMs: number | null
  readonly renewalCount: number
  readonly maxRenewals: number
  readonly progressScore: number
  readonly quarantineReason: string | null
}

export interface ProgressAttestation {
  readonly progressScore: number
  readonly summary: string
  readonly evidenceDigest?: string | undefined
  readonly requestedExtensionMs?: number | undefined
}

export interface LeaseRenewalResult {
  readonly leaseId: string
  readonly subagentId: string
  readonly approved: boolean
  readonly status: LeaseRenewalStatus
  readonly previousExpiresAtMs: number | null
  readonly newExpiresAtMs: number | null
  readonly renewalCount: number
  readonly progressScore: number
  readonly reason: string
  readonly lease: SubagentLease | null
}

export interface CapabilityAccessDecision {
  readonly allowed: boolean
  readonly leaseId: string
  readonly subagentId: string | null
  readonly capability: SubagentCapability
  readonly zone: QuarantineZone | null
  readonly leaseStatus: LeaseStatus | 'MISSING'
  readonly reason: string
  readonly evaluatedAtMs: number
}

export interface QuarantinedSubagentRecord {
  readonly subagentId: string
  readonly reason: string
  readonly quarantinedAtMs: number
}

export interface QuarantineCoordinatorMetrics {
  readonly totalIssued: number
  readonly totalRenewalsApproved: number
  readonly totalRenewalsDenied: number
  readonly totalExpirations: number
  readonly totalAccessChecks: number
  readonly totalAccessDenials: number
  readonly totalQuarantined: number
}

export interface QuarantineCoordinatorSnapshot {
  readonly policy: QuarantinePolicy
  readonly activeLeases: readonly SubagentLease[]
  readonly inactiveLeases: readonly SubagentLease[]
  readonly quarantinedSubagents: readonly QuarantinedSubagentRecord[]
  readonly metrics: QuarantineCoordinatorMetrics
  readonly snapshotDigest: string
}

export interface QuarantineCoordinatorOptions {
  readonly policy?: Partial<QuarantinePolicy> | undefined
  readonly clock?: (() => number) | undefined
}

export class QuarantinePolicyError extends Error {
  constructor(message: string) {
    super(`Quarantine policy error: ${message}`)
    this.name = 'QuarantinePolicyError'
  }
}

export class QuarantineAccessDeniedError extends Error {
  readonly decision: CapabilityAccessDecision

  constructor(decision: CapabilityAccessDecision) {
    super(`Quarantine access denied for "${decision.capability}": ${decision.reason}`)
    this.name = 'QuarantineAccessDeniedError'
    this.decision = decision
  }
}

const DEFAULT_ZONE_CAPABILITIES: Readonly<Record<QuarantineZone, readonly SubagentCapability[]>> = {
  QUARANTINED: [],
  STRICT: ['FILE_READ'],
  SANDBOXED: ['FILE_READ', 'FILE_WRITE', 'GIT_MUTATE'],
  ELEVATED: [
    'FILE_READ',
    'FILE_WRITE',
    'PROCESS_SPAWN',
    'NETWORK_EGRESS',
    'GIT_MUTATE',
    'DB_WRITE',
    'SECRET_ACCESS',
  ],
}

const DEFAULT_POLICY: QuarantinePolicy = {
  defaultLeaseTtlMs: 30_000,
  maxLeaseTtlMs: 300_000,
  maxRenewals: 3,
  minProgressDeltaPerRenewal: 0.05,
  allowedCapabilitiesByZone: DEFAULT_ZONE_CAPABILITIES,
  requireAttestationDigest: true,
  enableExpirationTimers: true,
}

interface InternalLease {
  readonly leaseId: string
  readonly subagentId: string
  zone: QuarantineZone
  status: LeaseStatus
  readonly grantedCapabilities: readonly SubagentCapability[]
  readonly deniedCapabilities: readonly SubagentCapability[]
  readonly allowedPaths: readonly string[]
  readonly issuedAtMs: number
  expiresAtMs: number
  lastRenewedAtMs: number | null
  renewalCount: number
  readonly maxRenewals: number
  progressScore: number
  quarantineReason: string | null
  timer?: NodeJS.Timeout | undefined
}

function isPathWithinAllowed(allowedRoots: readonly string[], targetPath: string): boolean {
  const resolvedTarget = resolve(targetPath)
  for (const root of allowedRoots) {
    const resolvedRoot = resolve(root)
    const rel = relative(resolvedRoot, resolvedTarget)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return true
    }
  }
  return false
}

/**
 * Subagent Capability Quarantine and Lease Renewal Coordinator (AGENT-033).
 * Enforces time-bounded capability leases, fail-closed access fences, quarantine isolation,
 * and progress-attested explicit lease renewals.
 */
export class SubagentCapabilityQuarantineCoordinator {
  private readonly policy: QuarantinePolicy
  private readonly clock: () => number

  private readonly leases = new Map<string, InternalLease>()
  private readonly quarantinedSubagents = new Map<string, QuarantinedSubagentRecord>()

  private totalIssued = 0
  private totalRenewalsApproved = 0
  private totalRenewalsDenied = 0
  private totalExpirations = 0
  private totalAccessChecks = 0
  private totalAccessDenials = 0
  private totalQuarantined = 0

  constructor(options: QuarantineCoordinatorOptions = {}) {
    const p = options.policy ?? {}
    const defaultLeaseTtlMs = p.defaultLeaseTtlMs ?? DEFAULT_POLICY.defaultLeaseTtlMs
    const maxLeaseTtlMs = p.maxLeaseTtlMs ?? DEFAULT_POLICY.maxLeaseTtlMs
    const maxRenewals = p.maxRenewals ?? DEFAULT_POLICY.maxRenewals
    const minProgressDeltaPerRenewal =
      p.minProgressDeltaPerRenewal ?? DEFAULT_POLICY.minProgressDeltaPerRenewal

    if (!Number.isInteger(defaultLeaseTtlMs) || defaultLeaseTtlMs <= 0) {
      throw new QuarantinePolicyError('defaultLeaseTtlMs must be a positive integer')
    }
    if (!Number.isInteger(maxLeaseTtlMs) || maxLeaseTtlMs < defaultLeaseTtlMs) {
      throw new QuarantinePolicyError('maxLeaseTtlMs must be >= defaultLeaseTtlMs')
    }
    if (!Number.isInteger(maxRenewals) || maxRenewals < 0) {
      throw new QuarantinePolicyError('maxRenewals must be a non-negative integer')
    }
    if (
      !Number.isFinite(minProgressDeltaPerRenewal) ||
      minProgressDeltaPerRenewal < 0 ||
      minProgressDeltaPerRenewal > 1
    ) {
      throw new QuarantinePolicyError('minProgressDeltaPerRenewal must be within [0, 1]')
    }

    this.policy = {
      defaultLeaseTtlMs,
      maxLeaseTtlMs,
      maxRenewals,
      minProgressDeltaPerRenewal,
      allowedCapabilitiesByZone:
        p.allowedCapabilitiesByZone ?? DEFAULT_POLICY.allowedCapabilitiesByZone,
      requireAttestationDigest:
        p.requireAttestationDigest ?? DEFAULT_POLICY.requireAttestationDigest,
      enableExpirationTimers: p.enableExpirationTimers ?? DEFAULT_POLICY.enableExpirationTimers,
    }
    this.clock = options.clock ?? Date.now
  }

  /**
   * Issues a time-bounded capability lease scoped to the subagent's quarantine zone.
   */
  public issueLease(request: IssueLeaseRequest): SubagentLease {
    const subagentId = request.subagentId.trim()
    if (subagentId.length === 0) {
      throw new QuarantinePolicyError('subagentId must be a non-empty string')
    }

    if (this.quarantinedSubagents.has(subagentId)) {
      throw new QuarantinePolicyError(
        `Subagent "${subagentId}" is currently quarantined and cannot receive a new capability lease`,
      )
    }

    const ttlMs = request.ttlMs ?? this.policy.defaultLeaseTtlMs
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > this.policy.maxLeaseTtlMs) {
      throw new QuarantinePolicyError(
        `Requested ttlMs (${String(ttlMs)}) exceeds allowed bounds (1..${String(this.policy.maxLeaseTtlMs)})`,
      )
    }

    const zone: QuarantineZone = request.zone ?? 'SANDBOXED'
    const zoneAllowed = new Set<SubagentCapability>(this.policy.allowedCapabilitiesByZone[zone])
    const granted: SubagentCapability[] = []
    const denied: SubagentCapability[] = []

    for (const cap of request.requestedCapabilities) {
      if (zoneAllowed.has(cap)) {
        if (!granted.includes(cap)) {
          granted.push(cap)
        }
      } else if (!denied.includes(cap)) {
        denied.push(cap)
      }
    }

    const maxRenewals = request.maxRenewals ?? this.policy.maxRenewals
    if (!Number.isInteger(maxRenewals) || maxRenewals < 0) {
      throw new QuarantinePolicyError('maxRenewals must be a non-negative integer')
    }

    const initialProgress = request.initialProgressScore ?? 0
    if (!Number.isFinite(initialProgress) || initialProgress < 0 || initialProgress > 1) {
      throw new QuarantinePolicyError('initialProgressScore must be within [0, 1]')
    }

    const now = this.clock()
    const internal: InternalLease = {
      leaseId: randomUUID(),
      subagentId,
      zone,
      status: zone === 'QUARANTINED' ? 'QUARANTINED' : 'ACTIVE',
      grantedCapabilities: granted,
      deniedCapabilities: denied,
      allowedPaths: (request.allowedPaths ?? []).map((p) => resolve(p)),
      issuedAtMs: now,
      expiresAtMs: now + Math.round(ttlMs),
      lastRenewedAtMs: null,
      renewalCount: 0,
      maxRenewals,
      progressScore: initialProgress,
      quarantineReason: zone === 'QUARANTINED' ? 'Issued directly into QUARANTINED zone' : null,
    }

    this.leases.set(internal.leaseId, internal)
    this.totalIssued++
    if (internal.status === 'ACTIVE') {
      this.scheduleExpirationTimer(internal, Math.round(ttlMs))
    }

    return this.toSnapshot(internal)
  }

  /**
   * Evaluates whether a subagent lease currently authorizes a capability (and optional path).
   */
  public evaluateAccess(
    leaseId: string,
    capability: SubagentCapability,
    targetPath?: string,
  ): CapabilityAccessDecision {
    this.totalAccessChecks++
    const now = this.clock()
    const lease = this.leases.get(leaseId)

    if (!lease) {
      this.totalAccessDenials++
      return {
        allowed: false,
        leaseId,
        subagentId: null,
        capability,
        zone: null,
        leaseStatus: 'MISSING',
        reason: 'Lease does not exist',
        evaluatedAtMs: now,
      }
    }

    this.syncExpiration(lease, now)

    const deny = (reason: string): CapabilityAccessDecision => {
      this.totalAccessDenials++
      return {
        allowed: false,
        leaseId: lease.leaseId,
        subagentId: lease.subagentId,
        capability,
        zone: lease.zone,
        leaseStatus: lease.status,
        reason,
        evaluatedAtMs: now,
      }
    }

    if (this.quarantinedSubagents.has(lease.subagentId) || lease.status === 'QUARANTINED') {
      return deny(
        lease.quarantineReason ?? `Subagent "${lease.subagentId}" is fenced in quarantine`,
      )
    }
    if (lease.status === 'EXPIRED') {
      return deny('Capability lease has expired')
    }
    if (lease.status === 'REVOKED') {
      return deny('Capability lease has been revoked')
    }
    if (!lease.grantedCapabilities.includes(capability)) {
      return deny(`Capability "${capability}" is not granted in zone "${lease.zone}"`)
    }
    if (targetPath !== undefined && lease.allowedPaths.length > 0) {
      if (!isPathWithinAllowed(lease.allowedPaths, targetPath)) {
        return deny(`Target path "${targetPath}" escapes lease sandbox boundaries`)
      }
    }

    return {
      allowed: true,
      leaseId: lease.leaseId,
      subagentId: lease.subagentId,
      capability,
      zone: lease.zone,
      leaseStatus: lease.status,
      reason: 'Authorized within active capability lease and zone boundaries',
      evaluatedAtMs: now,
    }
  }

  /**
   * Enforces fail-closed capability gating, throwing QuarantineAccessDeniedError when denied.
   */
  public assertAccess(leaseId: string, capability: SubagentCapability, targetPath?: string): void {
    const decision = this.evaluateAccess(leaseId, capability, targetPath)
    if (!decision.allowed) {
      throw new QuarantineAccessDeniedError(decision)
    }
  }

  /**
   * Explicitly renews an active capability lease upon verified forward progress and attestation.
   */
  public renewLease(leaseId: string, attestation: ProgressAttestation): LeaseRenewalResult {
    const now = this.clock()
    const lease = this.leases.get(leaseId)

    if (!lease) {
      this.totalRenewalsDenied++
      return {
        leaseId,
        subagentId: 'unknown',
        approved: false,
        status: 'DENIED_NOT_FOUND',
        previousExpiresAtMs: null,
        newExpiresAtMs: null,
        renewalCount: 0,
        progressScore: 0,
        reason: 'Lease not found',
        lease: null,
      }
    }

    this.syncExpiration(lease, now)

    const rejectRenewal = (status: LeaseRenewalStatus, reason: string): LeaseRenewalResult => {
      this.totalRenewalsDenied++
      return {
        leaseId: lease.leaseId,
        subagentId: lease.subagentId,
        approved: false,
        status,
        previousExpiresAtMs: lease.expiresAtMs,
        newExpiresAtMs: null,
        renewalCount: lease.renewalCount,
        progressScore: lease.progressScore,
        reason,
        lease: this.toSnapshot(lease),
      }
    }

    if (this.quarantinedSubagents.has(lease.subagentId) || lease.status === 'QUARANTINED') {
      return rejectRenewal(
        'DENIED_QUARANTINED',
        lease.quarantineReason ?? 'Subagent is in quarantine',
      )
    }
    if (lease.status === 'EXPIRED') {
      return rejectRenewal('DENIED_EXPIRED', 'Cannot renew an expired lease')
    }
    if (lease.status === 'REVOKED') {
      return rejectRenewal('DENIED_REVOKED', 'Cannot renew a revoked lease')
    }
    if (lease.renewalCount >= lease.maxRenewals) {
      return rejectRenewal(
        'DENIED_MAX_RENEWALS',
        `Maximum renewals (${String(lease.maxRenewals)}) already exhausted`,
      )
    }

    if (attestation.summary.trim().length < 3) {
      return rejectRenewal(
        'DENIED_INVALID_ATTESTATION',
        'Progress attestation summary must be at least 3 characters',
      )
    }
    if (
      this.policy.requireAttestationDigest &&
      (!attestation.evidenceDigest || attestation.evidenceDigest.trim().length < 8)
    ) {
      return rejectRenewal(
        'DENIED_INVALID_ATTESTATION',
        'Verified evidenceDigest is required for lease renewal',
      )
    }

    if (
      !Number.isFinite(attestation.progressScore) ||
      attestation.progressScore < 0 ||
      attestation.progressScore > 1
    ) {
      return rejectRenewal('DENIED_INSUFFICIENT_PROGRESS', 'progressScore must be within [0, 1]')
    }

    const delta = attestation.progressScore - lease.progressScore
    if (delta + 1e-9 < this.policy.minProgressDeltaPerRenewal) {
      return rejectRenewal(
        'DENIED_INSUFFICIENT_PROGRESS',
        `Progress delta (${delta.toFixed(3)}) is below minimum required (${String(this.policy.minProgressDeltaPerRenewal)})`,
      )
    }

    const extensionMs = Math.min(
      this.policy.maxLeaseTtlMs,
      Math.max(1, Math.round(attestation.requestedExtensionMs ?? this.policy.defaultLeaseTtlMs)),
    )
    const previousExpiresAtMs = lease.expiresAtMs
    lease.expiresAtMs = now + extensionMs
    lease.lastRenewedAtMs = now
    lease.renewalCount++
    lease.progressScore = attestation.progressScore

    this.scheduleExpirationTimer(lease, extensionMs)
    this.totalRenewalsApproved++

    return {
      leaseId: lease.leaseId,
      subagentId: lease.subagentId,
      approved: true,
      status: 'RENEWED',
      previousExpiresAtMs,
      newExpiresAtMs: lease.expiresAtMs,
      renewalCount: lease.renewalCount,
      progressScore: lease.progressScore,
      reason: `Renewed for ${String(extensionMs)}ms on verified progress (${attestation.summary.trim()})`,
      lease: this.toSnapshot(lease),
    }
  }

  /**
   * Moves a subagent immediately into quarantine, fencing all existing active leases.
   */
  public quarantineSubagent(subagentId: string, reason: string): number {
    const cleanId = subagentId.trim()
    const cleanReason = reason.trim() || 'Quarantined due to policy violation'
    const now = this.clock()

    this.quarantinedSubagents.set(cleanId, {
      subagentId: cleanId,
      reason: cleanReason,
      quarantinedAtMs: now,
    })
    this.totalQuarantined++

    let fencedCount = 0
    for (const lease of this.leases.values()) {
      if (lease.subagentId === cleanId && lease.status === 'ACTIVE') {
        lease.zone = 'QUARANTINED'
        lease.status = 'QUARANTINED'
        lease.quarantineReason = cleanReason
        this.clearTimer(lease)
        fencedCount++
      }
    }
    return fencedCount
  }

  /**
   * Lifts subagent-level quarantine hold upon explicit authorization token. Previously fenced leases remain closed.
   */
  public releaseFromQuarantine(subagentId: string, authorizationToken: string): boolean {
    if (authorizationToken.trim().length < 4) {
      throw new QuarantinePolicyError(
        'Authorization token of >= 4 characters required to clear quarantine hold',
      )
    }
    return this.quarantinedSubagents.delete(subagentId.trim())
  }

  /**
   * Explicitly revokes a capability lease and clears its expiration timer.
   */
  public revokeLease(leaseId: string, reason = 'Explicit lease revocation'): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.status === 'REVOKED') {
      return false
    }
    lease.status = 'REVOKED'
    lease.quarantineReason = reason
    this.clearTimer(lease)
    return true
  }

  /**
   * Sweeps all active leases against the current clock and marks elapsed leases expired.
   */
  public sweepExpired(): number {
    const now = this.clock()
    let expiredCount = 0
    for (const lease of this.leases.values()) {
      if (lease.status === 'ACTIVE' && now >= lease.expiresAtMs) {
        this.markExpired(lease)
        expiredCount++
      }
    }
    return expiredCount
  }

  /**
   * Clears all active timers cleanly (safe shutdown without handle leaks).
   */
  public dispose(): void {
    for (const lease of this.leases.values()) {
      this.clearTimer(lease)
    }
  }

  /**
   * Produces a full coordinator state snapshot and deterministic SHA-256 digest.
   */
  public getSnapshot(): QuarantineCoordinatorSnapshot {
    this.sweepExpired()

    const activeLeases: SubagentLease[] = []
    const inactiveLeases: SubagentLease[] = []
    for (const lease of this.leases.values()) {
      const snap = this.toSnapshot(lease)
      if (lease.status === 'ACTIVE') {
        activeLeases.push(snap)
      } else {
        inactiveLeases.push(snap)
      }
    }

    const quarantinedSubagents = Array.from(this.quarantinedSubagents.values())
    const metrics: QuarantineCoordinatorMetrics = {
      totalIssued: this.totalIssued,
      totalRenewalsApproved: this.totalRenewalsApproved,
      totalRenewalsDenied: this.totalRenewalsDenied,
      totalExpirations: this.totalExpirations,
      totalAccessChecks: this.totalAccessChecks,
      totalAccessDenials: this.totalAccessDenials,
      totalQuarantined: this.totalQuarantined,
    }

    const snapshotDigest = createHash('sha256')
      .update(
        JSON.stringify({
          activeLeases,
          inactiveLeases,
          quarantinedSubagents,
          metrics,
        }),
      )
      .digest('hex')

    return {
      policy: this.policy,
      activeLeases,
      inactiveLeases,
      quarantinedSubagents,
      metrics,
      snapshotDigest,
    }
  }

  private scheduleExpirationTimer(lease: InternalLease, delayMs: number): void {
    this.clearTimer(lease)
    if (!this.policy.enableExpirationTimers) {
      return
    }
    lease.timer = setTimeout(() => {
      if (lease.status === 'ACTIVE') {
        this.markExpired(lease)
      }
    }, delayMs)
    lease.timer.unref()
  }

  private clearTimer(lease: InternalLease): void {
    if (lease.timer) {
      clearTimeout(lease.timer)
      lease.timer = undefined
    }
  }

  private syncExpiration(lease: InternalLease, now: number): void {
    if (lease.status === 'ACTIVE' && now >= lease.expiresAtMs) {
      this.markExpired(lease)
    }
  }

  private markExpired(lease: InternalLease): void {
    if (lease.status === 'ACTIVE') {
      lease.status = 'EXPIRED'
      this.totalExpirations++
      this.clearTimer(lease)
    }
  }

  private toSnapshot(lease: InternalLease): SubagentLease {
    return {
      leaseId: lease.leaseId,
      subagentId: lease.subagentId,
      zone: lease.zone,
      status: lease.status,
      grantedCapabilities: [...lease.grantedCapabilities],
      deniedCapabilities: [...lease.deniedCapabilities],
      allowedPaths: [...lease.allowedPaths],
      issuedAtMs: lease.issuedAtMs,
      expiresAtMs: lease.expiresAtMs,
      lastRenewedAtMs: lease.lastRenewedAtMs,
      renewalCount: lease.renewalCount,
      maxRenewals: lease.maxRenewals,
      progressScore: lease.progressScore,
      quarantineReason: lease.quarantineReason,
    }
  }
}

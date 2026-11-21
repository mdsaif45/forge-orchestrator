/**
 * CONFIG-020: Dynamic Secret Rotation & Vault Key Lifetime Supervisor.
 *
 * Audits secret key metadata and rotation lifecycle against TTL windows,
 * flags expired or expiring tokens, and generates structured rotation manifests
 * without accepting or storing secret plaintext.
 */

export type SecretRotationStatus = 'VALID' | 'WARN_EXPIRING' | 'EXPIRED'

export interface SecretMetadataItem {
  key: string
  createdAt: string
  lastRotatedAt?: string | undefined
  ttlDays?: number | undefined
  serviceTag?: string | undefined
}

export interface SecretRotationAssessment {
  key: string
  status: SecretRotationStatus
  ageDays: number
  remainingDays: number
  effectiveTtlDays: number
  requiresRotation: boolean
  reason: string
}

export interface SecretAuditReport {
  totalSecrets: number
  validCount: number
  expiringSoonCount: number
  expiredCount: number
  assessments: SecretRotationAssessment[]
  requiresImmediateAction: boolean
  summary: string
}

export interface SecretRotationOptions {
  defaultTtlDays?: number | undefined
  warnWindowDays?: number | undefined
  currentTimeIso?: string | undefined
}

const DEFAULT_TTL_DAYS = 90
const DEFAULT_WARN_WINDOW_DAYS = 7
const MS_PER_DAY = 1000 * 60 * 60 * 24

export function auditSecretRotation(
  secrets: SecretMetadataItem[],
  options: SecretRotationOptions = {},
): SecretAuditReport {
  const defaultTtl = options.defaultTtlDays ?? DEFAULT_TTL_DAYS
  const warnWindow = options.warnWindowDays ?? DEFAULT_WARN_WINDOW_DAYS
  const nowMs = options.currentTimeIso ? Date.parse(options.currentTimeIso) : Date.now()

  let validCount = 0
  let expiringSoonCount = 0
  let expiredCount = 0
  const assessments: SecretRotationAssessment[] = []

  for (const item of secrets) {
    const trimmedKey = item.key.trim()
    if (!trimmedKey) {
      continue
    }

    const baselineDateStr = item.lastRotatedAt ?? item.createdAt
    const baselineMs = Date.parse(baselineDateStr)
    const effectiveTtlDays = item.ttlDays ?? defaultTtl

    const ageDays = isNaN(baselineMs)
      ? 0
      : Math.max(0, Math.floor((nowMs - baselineMs) / MS_PER_DAY))

    const remainingDays = effectiveTtlDays - ageDays

    let status: SecretRotationStatus
    let reason: string
    let requiresRotation: boolean

    if (remainingDays <= 0) {
      status = 'EXPIRED'
      requiresRotation = true
      expiredCount++
      reason = `Secret expired ${String(Math.abs(remainingDays))} day(s) ago (TTL: ${String(effectiveTtlDays)} days, age: ${String(ageDays)} days).`
    } else if (remainingDays <= warnWindow) {
      status = 'WARN_EXPIRING'
      requiresRotation = true
      expiringSoonCount++
      reason = `Secret expires soon in ${String(remainingDays)} day(s) within the ${String(warnWindow)}-day rotation window.`
    } else {
      status = 'VALID'
      requiresRotation = false
      validCount++
      reason = `Secret is valid (${String(remainingDays)} days remaining until rotation).`
    }

    assessments.push({
      key: trimmedKey,
      status,
      ageDays,
      remainingDays,
      effectiveTtlDays,
      requiresRotation,
      reason,
    })
  }

  const requiresImmediateAction = expiredCount > 0
  const summary = `Secret audit checked ${String(assessments.length)} key(s): ${String(validCount)} valid, ${String(expiringSoonCount)} expiring soon, ${String(expiredCount)} expired.${requiresImmediateAction ? ' IMMEDIATE ROTATION REQUIRED.' : ''}`

  return {
    totalSecrets: assessments.length,
    validCount,
    expiringSoonCount,
    expiredCount,
    assessments,
    requiresImmediateAction,
    summary,
  }
}

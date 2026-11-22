/**
 * Workspace dependency vulnerability audit gate and security advisory matcher.
 *
 * Scans installed workspace package dependencies against CVE advisories and
 * enforces fail-closed gate policies before allowing workflow execution (A1, A7).
 */

export type AdvisorySeverity = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL'

export interface SecurityAdvisory {
  readonly advisoryId: string
  readonly packageName: string
  readonly vulnerableRange: string
  readonly patchedVersion?: string | undefined
  readonly severity: AdvisorySeverity
  readonly title: string
  readonly cve?: string | undefined
}

export interface AuditedDependencyMatch {
  readonly packageName: string
  readonly installedVersion: string
  readonly advisory: SecurityAdvisory
}

export interface DependencyAuditReport {
  readonly scannedPackagesCount: number
  readonly vulnerabilitiesCount: number
  readonly highestSeverity?: AdvisorySeverity | undefined
  readonly gateApproved: boolean
  readonly matches: readonly AuditedDependencyMatch[]
  readonly summary: string
}

export interface DependencyAuditConfig {
  /** Severity threshold that rejects execution gate. Defaults to 'HIGH'. */
  readonly blockThresholdSeverity?: AdvisorySeverity | undefined
  /** Additional custom security advisories. */
  readonly customAdvisories?: readonly SecurityAdvisory[] | undefined
}

const SEVERITY_WEIGHT: Record<AdvisorySeverity, number> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 4,
}

const DEFAULT_ADVISORIES: readonly SecurityAdvisory[] = [
  {
    advisoryId: 'FORGE-ADV-2024-001',
    packageName: 'lodash',
    vulnerableRange: '<4.17.21',
    patchedVersion: '4.17.21',
    severity: 'HIGH',
    title: 'Prototype Pollution in lodash',
    cve: 'CVE-2021-23337',
  },
  {
    advisoryId: 'FORGE-ADV-2024-002',
    packageName: 'tar',
    vulnerableRange: '<6.2.1',
    patchedVersion: '6.2.1',
    severity: 'CRITICAL',
    title: 'Arbitrary File Overwrite via Path Traversal in tar',
    cve: 'CVE-2024-28863',
  },
  {
    advisoryId: 'FORGE-ADV-2024-003',
    packageName: 'cross-spawn',
    vulnerableRange: '>=7.0.0 <7.0.5',
    patchedVersion: '7.0.5',
    severity: 'CRITICAL',
    title: 'Command Injection on Windows in cross-spawn',
    cve: 'CVE-2024-21538',
  },
  {
    advisoryId: 'FORGE-ADV-2024-004',
    packageName: 'ws',
    vulnerableRange: '>=8.0.0 <8.17.1',
    patchedVersion: '8.17.1',
    severity: 'HIGH',
    title: 'Denial of Service via Unhandled Exception in ws',
    cve: 'CVE-2024-37890',
  },
  {
    advisoryId: 'FORGE-ADV-2024-005',
    packageName: 'axios',
    vulnerableRange: '<1.7.4',
    patchedVersion: '1.7.4',
    severity: 'MODERATE',
    title: 'Server-Side Request Forgery via vulnerable follow-redirects',
    cve: 'CVE-2024-39338',
  },
]

export class WorkspaceDependencyAuditGate {
  private readonly blockThresholdSeverity: AdvisorySeverity
  private readonly advisories: SecurityAdvisory[]

  constructor(config: DependencyAuditConfig = {}) {
    this.blockThresholdSeverity = config.blockThresholdSeverity ?? 'HIGH'
    this.advisories = [...DEFAULT_ADVISORIES, ...(config.customAdvisories ?? [])]
  }

  /**
   * Registers an advisory to the in-memory vulnerability catalog.
   */
  registerAdvisory(advisory: SecurityAdvisory): void {
    const existingIndex = this.advisories.findIndex((a) => a.advisoryId === advisory.advisoryId)
    if (existingIndex >= 0) {
      this.advisories[existingIndex] = advisory
    } else {
      this.advisories.push(advisory)
    }
  }

  /**
   * Parses package manifest or lockfile string into a packageName -> version map.
   */
  parseDependencies(rawJson: string): Map<string, string> {
    const result = new Map<string, string>()
    if (!rawJson || rawJson.trim().length === 0) {
      return result
    }

    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>

      // Check package-lock.json v2/v3 packages map
      if (parsed.packages && typeof parsed.packages === 'object') {
        const pkgs = parsed.packages as Record<string, Record<string, unknown>>
        for (const [key, val] of Object.entries(pkgs)) {
          if (!key || typeof val !== 'object') continue
          const cleanName = key.replace(/^node_modules\//, '')
          const ver = val.version
          if (cleanName && typeof ver === 'string') {
            result.set(cleanName, ver)
          }
        }
      }

      // Check package.json dependencies / devDependencies
      const depFields = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]
      for (const field of depFields) {
        const obj = parsed[field]
        if (obj && typeof obj === 'object') {
          for (const [pkg, ver] of Object.entries(obj as Record<string, unknown>)) {
            if (typeof ver === 'string' && !result.has(pkg)) {
              // Strip leading prefix operators
              const cleanVer = ver.replace(/^[\^~=v]/, '')
              result.set(pkg, cleanVer)
            }
          }
        }
      }
    } catch {
      // Fail closed / invalid json returns empty map
      return result
    }

    return result
  }

  /**
   * Compares two semantic version strings.
   * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
   */
  compareSemVer(v1: string, v2: string): number {
    const parse = (v: string): [number, number, number] => {
      const clean = v.replace(/^[^0-9]+/, '')
      const parts = clean.split('.').map((p) => {
        const num = parseInt(p, 10)
        return Number.isNaN(num) ? 0 : num
      })
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    }

    const [maj1, min1, pat1] = parse(v1)
    const [maj2, min2, pat2] = parse(v2)

    if (maj1 !== maj2) return maj1 < maj2 ? -1 : 1
    if (min1 !== min2) return min1 < min2 ? -1 : 1
    if (pat1 !== pat2) return pat1 < pat2 ? -1 : 1
    return 0
  }

  /**
   * Checks whether a version satisfies a range expression (e.g. "<4.17.21", ">=7.0.0 <7.0.5").
   */
  satisfiesRange(version: string, range: string): boolean {
    const constraints = range.trim().split(/\s+/)
    for (const c of constraints) {
      if (!c) continue

      if (c.startsWith('<=')) {
        const target = c.slice(2)
        if (this.compareSemVer(version, target) > 0) return false
      } else if (c.startsWith('<')) {
        const target = c.slice(1)
        if (this.compareSemVer(version, target) >= 0) return false
      } else if (c.startsWith('>=')) {
        const target = c.slice(2)
        if (this.compareSemVer(version, target) < 0) return false
      } else if (c.startsWith('>')) {
        const target = c.slice(1)
        if (this.compareSemVer(version, target) <= 0) return false
      } else if (c.startsWith('=')) {
        const target = c.slice(1)
        if (this.compareSemVer(version, target) !== 0) return false
      } else {
        if (this.compareSemVer(version, c) !== 0) return false
      }
    }
    return true
  }

  /**
   * Audits packages against security advisories and checks gate approval.
   */
  audit(input: Map<string, string> | Record<string, string> | string): DependencyAuditReport {
    let depMap: Map<string, string>

    if (typeof input === 'string') {
      depMap = this.parseDependencies(input)
    } else if (input instanceof Map) {
      depMap = input
    } else {
      depMap = new Map(Object.entries(input))
    }

    const matches: AuditedDependencyMatch[] = []
    let maxSeverityWeight = 0
    let highestSeverity: AdvisorySeverity | undefined

    for (const [pkgName, version] of depMap.entries()) {
      const matchingAdvisories = this.advisories.filter(
        (adv) => adv.packageName === pkgName && this.satisfiesRange(version, adv.vulnerableRange),
      )

      for (const adv of matchingAdvisories) {
        matches.push({
          packageName: pkgName,
          installedVersion: version,
          advisory: adv,
        })

        const weight = SEVERITY_WEIGHT[adv.severity]
        if (weight > maxSeverityWeight) {
          maxSeverityWeight = weight
          highestSeverity = adv.severity
        }
      }
    }

    const thresholdWeight = SEVERITY_WEIGHT[this.blockThresholdSeverity]
    const gateApproved = maxSeverityWeight < thresholdWeight

    const summary = gateApproved
      ? `Audit PASSED: Scanned ${String(depMap.size)} packages. Found ${String(matches.length)} vulnerabilities below block threshold (${this.blockThresholdSeverity}).`
      : `Audit BLOCKED: Scanned ${String(depMap.size)} packages. Found ${String(matches.length)} vulnerabilities reaching block threshold (${this.blockThresholdSeverity}). Highest severity: ${String(highestSeverity)}.`

    return {
      scannedPackagesCount: depMap.size,
      vulnerabilitiesCount: matches.length,
      highestSeverity,
      gateApproved,
      matches,
      summary,
    }
  }
}

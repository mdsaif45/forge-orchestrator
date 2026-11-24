import { createHash } from 'node:crypto'
import * as path from 'node:path'

export type AgentCapabilityTier = 'RESTRICTED' | 'STANDARD' | 'ELEVATED' | 'ADMIN'

export type CapabilityType =
  'FILE_READ' | 'FILE_WRITE' | 'SHELL_EXEC' | 'NETWORK_FETCH' | 'CONFIG_MUTATE' | 'DB_ADMIN'

export interface CapabilityRequest {
  readonly agentId: string
  readonly tier: AgentCapabilityTier
  readonly capability: CapabilityType
  readonly targetPath?: string
  readonly targetCommand?: string
  readonly targetHost?: string
}

export type EscalationViolationCode =
  'TIER_INSUFFICIENT' | 'PATH_TRAVERSAL_ESCAPE' | 'DISALLOWED_COMMAND' | 'DISALLOWED_HOST'

export interface EscalationViolation {
  readonly code: EscalationViolationCode
  readonly message: string
  readonly requestedCapability: CapabilityType
  readonly details: Record<string, unknown>
}

export interface EscalationAuditResult {
  readonly isApproved: boolean
  readonly agentId: string
  readonly tier: AgentCapabilityTier
  readonly capability: CapabilityType
  readonly violations: readonly EscalationViolation[]
  readonly auditFingerprint: string
}

export interface EscalationAuditorConfig {
  readonly workspaceRoot: string
  readonly allowedCommandsByTier?: Partial<Record<AgentCapabilityTier, readonly string[]>>
  readonly allowedHostsByTier?: Partial<Record<AgentCapabilityTier, readonly string[]>>
}

export class PermissionEscalationDeniedError extends Error {
  public readonly agentId: string
  public readonly violations: readonly EscalationViolation[]

  constructor(agentId: string, violations: readonly EscalationViolation[]) {
    const msgs = violations.map((v) => `[${v.code}] ${v.message}`).join('; ')
    super(`Permission escalation denied for agent "${agentId}": ${msgs}`)
    this.name = 'PermissionEscalationDeniedError'
    this.agentId = agentId
    this.violations = violations
  }
}

const TIER_ALLOWED_CAPABILITIES: Record<AgentCapabilityTier, readonly CapabilityType[]> = {
  RESTRICTED: ['FILE_READ'],
  STANDARD: ['FILE_READ', 'FILE_WRITE'],
  ELEVATED: ['FILE_READ', 'FILE_WRITE', 'SHELL_EXEC', 'NETWORK_FETCH'],
  ADMIN: ['FILE_READ', 'FILE_WRITE', 'SHELL_EXEC', 'NETWORK_FETCH', 'CONFIG_MUTATE', 'DB_ADMIN'],
}

const DEFAULT_ALLOWED_COMMANDS: Record<AgentCapabilityTier, readonly string[]> = {
  RESTRICTED: [],
  STANDARD: ['git status', 'git diff', 'npm test'],
  ELEVATED: ['git', 'npm', 'node', 'npx', 'cargo', 'python', 'go'],
  ADMIN: ['*'],
}

const DEFAULT_ALLOWED_HOSTS: Record<AgentCapabilityTier, readonly string[]> = {
  RESTRICTED: [],
  STANDARD: [],
  ELEVATED: ['github.com', 'api.github.com', 'registry.npmjs.org'],
  ADMIN: ['*'],
}

export class WorkspacePermissionEscalationAuditor {
  private readonly workspaceRoot: string
  private readonly allowedCommands: Record<AgentCapabilityTier, readonly string[]>
  private readonly allowedHosts: Record<AgentCapabilityTier, readonly string[]>

  constructor(config: EscalationAuditorConfig) {
    this.workspaceRoot = path.resolve(config.workspaceRoot)
    this.allowedCommands = {
      RESTRICTED: config.allowedCommandsByTier?.RESTRICTED ?? DEFAULT_ALLOWED_COMMANDS.RESTRICTED,
      STANDARD: config.allowedCommandsByTier?.STANDARD ?? DEFAULT_ALLOWED_COMMANDS.STANDARD,
      ELEVATED: config.allowedCommandsByTier?.ELEVATED ?? DEFAULT_ALLOWED_COMMANDS.ELEVATED,
      ADMIN: config.allowedCommandsByTier?.ADMIN ?? DEFAULT_ALLOWED_COMMANDS.ADMIN,
    }
    this.allowedHosts = {
      RESTRICTED: config.allowedHostsByTier?.RESTRICTED ?? DEFAULT_ALLOWED_HOSTS.RESTRICTED,
      STANDARD: config.allowedHostsByTier?.STANDARD ?? DEFAULT_ALLOWED_HOSTS.STANDARD,
      ELEVATED: config.allowedHostsByTier?.ELEVATED ?? DEFAULT_ALLOWED_HOSTS.ELEVATED,
      ADMIN: config.allowedHostsByTier?.ADMIN ?? DEFAULT_ALLOWED_HOSTS.ADMIN,
    }
  }

  public auditCapabilityRequest(request: CapabilityRequest): EscalationAuditResult {
    const violations: EscalationViolation[] = []

    // 1. Check if capability is allowed for agent tier
    const permittedCaps = TIER_ALLOWED_CAPABILITIES[request.tier]
    if (!permittedCaps.includes(request.capability)) {
      violations.push({
        code: 'TIER_INSUFFICIENT',
        message: `Capability "${request.capability}" is not permitted for tier "${request.tier}"`,
        requestedCapability: request.capability,
        details: { allowedCapabilities: permittedCaps },
      })
    }

    // 2. Check path containment for file operations
    if (
      (request.capability === 'FILE_READ' || request.capability === 'FILE_WRITE') &&
      request.targetPath
    ) {
      const resolvedTarget = path.resolve(this.workspaceRoot, request.targetPath)
      const relative = path.relative(this.workspaceRoot, resolvedTarget)
      const isEscaping = relative.startsWith('..') || path.isAbsolute(relative)

      if (isEscaping) {
        violations.push({
          code: 'PATH_TRAVERSAL_ESCAPE',
          message: `Target path "${request.targetPath}" escapes designated workspace root "${this.workspaceRoot}"`,
          requestedCapability: request.capability,
          details: { targetPath: request.targetPath, workspaceRoot: this.workspaceRoot },
        })
      }
    }

    // 3. Check shell command authorization
    if (request.capability === 'SHELL_EXEC' && request.targetCommand) {
      const allowedCmds = this.allowedCommands[request.tier]
      const cmdBase = request.targetCommand.trim().split(/\s+/)[0] ?? ''
      const isAllowed =
        allowedCmds.includes('*') ||
        (cmdBase !== '' && allowedCmds.includes(cmdBase)) ||
        allowedCmds.includes(request.targetCommand.trim())

      if (!isAllowed) {
        violations.push({
          code: 'DISALLOWED_COMMAND',
          message: `Command "${request.targetCommand}" is not whitelisted for tier "${request.tier}"`,
          requestedCapability: request.capability,
          details: { command: request.targetCommand, allowedCommands: allowedCmds },
        })
      }
    }

    // 4. Check network destination authorization
    if (request.capability === 'NETWORK_FETCH' && request.targetHost) {
      const allowedHosts = this.allowedHosts[request.tier]
      const isAllowed = allowedHosts.includes('*') || allowedHosts.includes(request.targetHost)

      if (!isAllowed) {
        violations.push({
          code: 'DISALLOWED_HOST',
          message: `Host "${request.targetHost}" is not whitelisted for tier "${request.tier}"`,
          requestedCapability: request.capability,
          details: { host: request.targetHost, allowedHosts },
        })
      }
    }

    const isApproved = violations.length === 0
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ request, isApproved, violations }))
      .digest('hex')
      .slice(0, 16)

    return {
      isApproved,
      agentId: request.agentId,
      tier: request.tier,
      capability: request.capability,
      violations,
      auditFingerprint: `audit-${fingerprint}`,
    }
  }

  public assertCapabilityApproved(request: CapabilityRequest): EscalationAuditResult {
    const result = this.auditCapabilityRequest(request)
    if (!result.isApproved) {
      throw new PermissionEscalationDeniedError(request.agentId, result.violations)
    }
    return result
  }
}

import type { PermissionMode } from '@forge/shared'

export interface ToolCapabilityDescriptor {
  id: string
  name: string
  requiredBinaries?: string[] | undefined
  supportedPlatforms?: NodeJS.Platform[] | undefined
  minimumPermissionMode?: PermissionMode | undefined
  networkRequired?: boolean | undefined
  timeoutCeilingMs?: number | undefined
}

export interface CapabilityValidationContext {
  currentPlatform?: NodeJS.Platform | undefined
  activePermissionMode?: PermissionMode | undefined
  isOffline?: boolean | undefined
  availableBinaries?: string[] | undefined
}

export interface CapabilityValidationReport {
  capabilityId: string
  isReady: boolean
  missingBinaries: string[]
  platformSupported: boolean
  permissionSatisfied: boolean
  networkSatisfied: boolean
  diagnostics: string[]
  remediationHints: string[]
}

const PERMISSION_HIERARCHY: Record<PermissionMode, number> = {
  plan: 0,
  manual: 1,
  auto: 2,
  acceptEdits: 3,
  bypassPermissions: 4,
}

export class AgentCapabilityValidator {
  private readonly defaultContext: CapabilityValidationContext

  constructor(defaultContext?: CapabilityValidationContext) {
    this.defaultContext = {
      currentPlatform: defaultContext?.currentPlatform ?? process.platform,
      activePermissionMode: defaultContext?.activePermissionMode ?? 'acceptEdits',
      isOffline: defaultContext?.isOffline ?? false,
      availableBinaries: defaultContext?.availableBinaries ?? [],
    }
  }

  public validate(
    descriptor: ToolCapabilityDescriptor,
    overrideContext?: CapabilityValidationContext,
  ): CapabilityValidationReport {
    const context: CapabilityValidationContext = {
      currentPlatform:
        overrideContext?.currentPlatform ?? this.defaultContext.currentPlatform ?? process.platform,
      activePermissionMode:
        overrideContext?.activePermissionMode ??
        this.defaultContext.activePermissionMode ??
        'acceptEdits',
      isOffline: overrideContext?.isOffline ?? this.defaultContext.isOffline ?? false,
      availableBinaries:
        overrideContext?.availableBinaries ?? this.defaultContext.availableBinaries ?? [],
    }

    const diagnostics: string[] = []
    const remediationHints: string[] = []

    // 1. Platform validation
    let platformSupported = true
    if (descriptor.supportedPlatforms && descriptor.supportedPlatforms.length > 0) {
      const current = context.currentPlatform ?? process.platform
      if (!descriptor.supportedPlatforms.includes(current)) {
        platformSupported = false
        diagnostics.push(
          `Platform "${current}" is not supported by capability "${descriptor.id}". Supported platforms: ${descriptor.supportedPlatforms.join(', ')}.`,
        )
        remediationHints.push(
          `Execute on a supported platform or configure an alternative adapter for ${descriptor.id}.`,
        )
      }
    }

    // 2. Binary dependencies
    const missingBinaries: string[] = []
    if (descriptor.requiredBinaries && descriptor.requiredBinaries.length > 0) {
      const available = new Set(
        (context.availableBinaries ?? []).map((b) => b.toLowerCase().replace(/\.exe$/, '')),
      )
      for (const required of descriptor.requiredBinaries) {
        const normalized = required.toLowerCase().replace(/\.exe$/, '')
        if (!available.has(normalized)) {
          missingBinaries.push(required)
        }
      }

      if (missingBinaries.length > 0) {
        diagnostics.push(`Missing required executable binaries: ${missingBinaries.join(', ')}.`)
        remediationHints.push(
          `Ensure the following binaries are installed and accessible on PATH: ${missingBinaries.join(', ')}.`,
        )
      }
    }

    // 3. Permission mode hierarchy validation
    let permissionSatisfied = true
    if (descriptor.minimumPermissionMode) {
      const activeMode = context.activePermissionMode ?? 'acceptEdits'
      const requiredRank = PERMISSION_HIERARCHY[descriptor.minimumPermissionMode]
      const activeRank = PERMISSION_HIERARCHY[activeMode]

      if (activeRank < requiredRank) {
        permissionSatisfied = false
        diagnostics.push(
          `Active permission mode "${activeMode}" is insufficient. Required minimum mode is "${descriptor.minimumPermissionMode}".`,
        )
        remediationHints.push(
          `Elevate workspace permission mode to at least "${descriptor.minimumPermissionMode}".`,
        )
      }
    }

    // 4. Network requirement
    let networkSatisfied = true
    if (descriptor.networkRequired) {
      if (context.isOffline) {
        networkSatisfied = false
        diagnostics.push(
          `Capability "${descriptor.id}" requires external network access, but environment is configured as offline.`,
        )
        remediationHints.push(
          `Enable network connectivity or configure a local offline fallback for "${descriptor.id}".`,
        )
      }
    }

    const isReady =
      platformSupported && missingBinaries.length === 0 && permissionSatisfied && networkSatisfied

    return {
      capabilityId: descriptor.id,
      isReady,
      missingBinaries,
      platformSupported,
      permissionSatisfied,
      networkSatisfied,
      diagnostics,
      remediationHints,
    }
  }
}

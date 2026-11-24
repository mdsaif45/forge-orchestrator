/**
 * CONFIG-019: Dynamic Configuration Hot-Reload Watcher & Drift Notifier.
 *
 * Audits and computes configuration changes between active runtime configuration
 * and candidate files on disk. Enforces schema validation before transition,
 * distinguishes restart-required changes from hot-reloadable settings,
 * and maintains active configuration unchanged if candidate is invalid (fail-closed, A1, A2).
 */

export interface ConfigKeyDelta {
  key: string
  oldValue: unknown
  newValue: unknown
  changeType: 'added' | 'removed' | 'modified'
}

export interface ConfigReloadAssessment {
  isValid: boolean
  validationErrors: string[]
  hasChanges: boolean
  deltas: ConfigKeyDelta[]
  requiresRestart: boolean
  summary: string
  appliedConfig?: Record<string, unknown> | undefined
}

// Configuration keys that require full daemon/application restart
const RESTART_REQUIRED_KEYS = new Set([
  'dataDir',
  'dbBackend',
  'ipcSocketPath',
  'port',
  'listenAddress',
  'conpty',
])

/**
 * Validates candidate configuration object structure.
 */
export function validateCandidateConfig(raw: unknown): {
  isValid: boolean
  errors: string[]
  config?: Record<string, unknown> | undefined
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      isValid: false,
      errors: ['Candidate configuration must be a non-null object.'],
    }
  }

  const errors: string[] = []
  const config = raw as Record<string, unknown>

  // Check types of common fields if present
  if ('dataDir' in config && typeof config.dataDir !== 'string') {
    errors.push('Field "dataDir" must be a string.')
  }

  if ('logLevel' in config) {
    const validLevels = ['debug', 'info', 'warn', 'error', 'silent']
    if (typeof config.logLevel !== 'string' || !validLevels.includes(config.logLevel)) {
      errors.push(`Field "logLevel" must be one of: ${validLevels.join(', ')}.`)
    }
  }

  if ('models' in config && (typeof config.models !== 'object' || config.models === null)) {
    errors.push('Field "models" must be an object.')
  }

  if (
    'telemetry' in config &&
    (typeof config.telemetry !== 'object' || config.telemetry === null)
  ) {
    errors.push('Field "telemetry" must be an object.')
  }

  return {
    isValid: errors.length === 0,
    errors,
    config: errors.length === 0 ? config : undefined,
  }
}

/**
 * Recursively flattens an object into dot-notated key-value map.
 */
export function flattenConfig(obj: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>()

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      const nested = flattenConfig(value as Record<string, unknown>, fullKey)
      for (const [nKey, nVal] of nested.entries()) {
        result.set(nKey, nVal)
      }
    } else {
      result.set(fullKey, value)
    }
  }

  return result
}

/**
 * Compares active runtime configuration against candidate on-disk configuration.
 */
export function evaluateConfigReload(
  activeConfig: Record<string, unknown>,
  candidateRaw: unknown,
): ConfigReloadAssessment {
  const validation = validateCandidateConfig(candidateRaw)

  if (!validation.isValid || !validation.config) {
    return {
      isValid: false,
      validationErrors: validation.errors,
      hasChanges: false,
      deltas: [],
      requiresRestart: false,
      summary: `Candidate configuration is invalid (${String(validation.errors.length)} errors). Active configuration preserved.`,
    }
  }

  const candidateConfig = validation.config
  const activeFlat = flattenConfig(activeConfig)
  const candidateFlat = flattenConfig(candidateConfig)

  const deltas: ConfigKeyDelta[] = []
  let requiresRestart = false

  // Check for modified and removed keys
  for (const [key, oldVal] of activeFlat.entries()) {
    const rootKey = key.split('.')[0] ?? key
    if (!candidateFlat.has(key)) {
      deltas.push({
        key,
        oldValue: oldVal,
        newValue: undefined,
        changeType: 'removed',
      })
      if (RESTART_REQUIRED_KEYS.has(rootKey)) {
        requiresRestart = true
      }
    } else {
      const newVal = candidateFlat.get(key)
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        deltas.push({
          key,
          oldValue: oldVal,
          newValue: newVal,
          changeType: 'modified',
        })
        if (RESTART_REQUIRED_KEYS.has(rootKey)) {
          requiresRestart = true
        }
      }
    }
  }

  // Check for added keys
  for (const [key, newVal] of candidateFlat.entries()) {
    if (!activeFlat.has(key)) {
      const rootKey = key.split('.')[0] ?? key
      deltas.push({
        key,
        oldValue: undefined,
        newValue: newVal,
        changeType: 'added',
      })
      if (RESTART_REQUIRED_KEYS.has(rootKey)) {
        requiresRestart = true
      }
    }
  }

  const hasChanges = deltas.length > 0
  let summary: string

  if (!hasChanges) {
    summary = 'No configuration changes detected. Active configuration is up to date.'
  } else {
    const changeCounts = `${String(deltas.length)} change(s) detected (${String(deltas.filter((d) => d.changeType === 'added').length)} added, ${String(deltas.filter((d) => d.changeType === 'modified').length)} modified, ${String(deltas.filter((d) => d.changeType === 'removed').length)} removed).`
    const restartNote = requiresRestart
      ? ' RESTART REQUIRED: modified critical subsystem keys.'
      : ' HOT RELOADABLE: can be applied dynamically.'
    summary = `${changeCounts}${restartNote}`
  }

  return {
    isValid: true,
    validationErrors: [],
    hasChanges,
    deltas,
    requiresRestart,
    summary,
    appliedConfig: hasChanges ? candidateConfig : undefined,
  }
}

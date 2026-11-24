/**
 * CONFIG-017: Hierarchical Workspace Configuration Inheritance Resolver & Override Conflict Detector
 *
 * Resolves effective configuration across layered precedence levels:
 * defaults < global < workspace < cli
 * Tracks key origin provenance, detects incompatible type mutations, and enforces
 * locked administrative key immutability.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed validation and zero `any`.
 * - A2: Boundary enforcement.
 * - A4: Immutable resolution origin mapping.
 * - A7: Least privilege and locked administrative protection.
 */

export type ConfigLayerName = 'defaults' | 'global' | 'workspace' | 'cli'

export interface ConfigLayer {
  readonly name: ConfigLayerName
  readonly values: Record<string, unknown>
}

export type ConflictType = 'locked_override' | 'type_mismatch'

export interface ConflictDetail {
  readonly key: string
  readonly type: ConflictType
  readonly baseLayer: ConfigLayerName
  readonly overridingLayer: ConfigLayerName
  readonly message: string
}

export interface ResolvedConfigResult {
  readonly effectiveConfig: Record<string, unknown>
  readonly originMap: Record<string, ConfigLayerName>
  readonly conflicts: readonly ConflictDetail[]
  readonly valid: boolean
  readonly formattedSummary: string
}

export interface InheritanceResolverOptions {
  readonly lockedKeys?: readonly string[] | undefined
}

const LAYER_ORDER: readonly ConfigLayerName[] = ['defaults', 'global', 'workspace', 'cli']

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function getValueType(val: unknown): string {
  if (val === null) return 'null'
  if (Array.isArray(val)) return 'array'
  return typeof val
}

/**
 * Resolves layered configurations with origin tracking, type mismatch detection, and locked key enforcement.
 */
export function resolveConfigInheritance(
  layers: readonly ConfigLayer[],
  options?: InheritanceResolverOptions,
): ResolvedConfigResult {
  const lockedKeysSet = new Set<string>(options?.lockedKeys ?? [])
  const conflicts: ConflictDetail[] = []
  const effectiveConfig: Record<string, unknown> = {}
  const originMap: Record<string, ConfigLayerName> = {}

  // Sort layers strictly by predefined precedence order
  const sortedLayers = [...layers].sort((a, b) => {
    return LAYER_ORDER.indexOf(a.name) - LAYER_ORDER.indexOf(b.name)
  })

  function mergeObjects(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    layerName: ConfigLayerName,
    pathPrefix: string,
    depth: number,
  ): void {
    if (depth > 10) {
      return // Bounded recursion limit (A5)
    }

    for (const [key, sourceVal] of Object.entries(source)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key
      const isLocked = lockedKeysSet.has(fullPath) || lockedKeysSet.has(key)

      if (Object.prototype.hasOwnProperty.call(target, key)) {
        const existingVal = target[key]
        const existingOrigin = originMap[fullPath] ?? 'defaults'

        // Check locked key violation
        if (isLocked && JSON.stringify(existingVal) !== JSON.stringify(sourceVal)) {
          conflicts.push({
            key: fullPath,
            type: 'locked_override',
            baseLayer: existingOrigin,
            overridingLayer: layerName,
            message: `Attempted to override locked key '${fullPath}' from layer '${layerName}' (locked in '${existingOrigin}').`,
          })
          continue
        }

        // Check object recursive merge vs type mismatch
        if (isPlainObject(existingVal) && isPlainObject(sourceVal)) {
          mergeObjects(existingVal, sourceVal, layerName, fullPath, depth + 1)
          originMap[fullPath] = layerName
        } else {
          const existingType = getValueType(existingVal)
          const sourceType = getValueType(sourceVal)

          if (existingType !== sourceType && existingVal !== undefined && sourceVal !== undefined) {
            conflicts.push({
              key: fullPath,
              type: 'type_mismatch',
              baseLayer: existingOrigin,
              overridingLayer: layerName,
              message: `Type mismatch on key '${fullPath}': '${existingType}' in '${existingOrigin}' overridden by '${sourceType}' in '${layerName}'.`,
            })
          }

          target[key] = sourceVal
          originMap[fullPath] = layerName
        }
      } else {
        target[key] = isPlainObject(sourceVal) ? deepCloneObject(sourceVal) : sourceVal
        originMap[fullPath] = layerName

        if (isPlainObject(sourceVal)) {
          recordNestedOrigins(sourceVal, layerName, fullPath, depth + 1)
        }
      }
    }
  }

  function recordNestedOrigins(
    obj: Record<string, unknown>,
    layerName: ConfigLayerName,
    pathPrefix: string,
    depth: number,
  ): void {
    if (depth > 10) return
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = `${pathPrefix}.${key}`
      originMap[fullPath] = layerName
      if (isPlainObject(val)) {
        recordNestedOrigins(val, layerName, fullPath, depth + 1)
      }
    }
  }

  function deepCloneObject(obj: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
  }

  for (const layer of sortedLayers) {
    mergeObjects(effectiveConfig, layer.values, layer.name, '', 0)
  }

  const valid = conflicts.length === 0
  const formattedSummary = valid
    ? `[Config Inheritance OK] Resolved ${String(Object.keys(effectiveConfig).length)} root keys across ${String(sortedLayers.length)} layers without conflicts.`
    : `[Config Inheritance FAIL] Detected ${String(conflicts.length)} conflict(s): ${conflicts.map((c) => c.message).join(' ')}`

  return {
    effectiveConfig,
    originMap,
    conflicts,
    valid,
    formattedSummary,
  }
}

/**
 * Detects whether any layer contains overrides that conflict with administrative locked keys.
 */
export function detectConfigConflicts(
  layers: readonly ConfigLayer[],
  lockedKeys: readonly string[],
): readonly ConflictDetail[] {
  const result = resolveConfigInheritance(layers, { lockedKeys })
  return result.conflicts
}

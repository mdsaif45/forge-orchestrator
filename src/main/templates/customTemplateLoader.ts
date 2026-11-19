import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { type WorkflowTemplateV2 } from '@shared/domain'
import { validateTemplateGraph } from '../workflows/validation'
import type { TemplateV2Store } from './templateV2Store'

export interface CustomTemplateValidationResult {
  readonly valid: boolean
  readonly filePath: string
  readonly template?: WorkflowTemplateV2 | undefined
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export interface CustomTemplateDiscoveryResult {
  readonly templates: readonly WorkflowTemplateV2[]
  readonly errors: readonly { readonly path: string; readonly error: string }[]
  readonly scannedDirectories: readonly string[]
}

/**
 * Validates a single custom workflow template JSON file against schema and DAG topology invariants.
 *
 * Implements Axiom A2 (Fail-closed): Invalid or cyclic DAG templates fail closed with detailed errors.
 */
export async function validateCustomTemplateFile(
  filePath: string,
): Promise<CustomTemplateValidationResult> {
  const resolvedPath = resolve(filePath)
  if (!existsSync(resolvedPath)) {
    return {
      valid: false,
      filePath: resolvedPath,
      errors: [`Template file not found: ${resolvedPath}`],
      warnings: [],
    }
  }

  let rawContent: string
  try {
    rawContent = await readFile(resolvedPath, 'utf8')
  } catch (err) {
    return {
      valid: false,
      filePath: resolvedPath,
      errors: [`Failed to read template file: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawContent)
  } catch (err) {
    return {
      valid: false,
      filePath: resolvedPath,
      errors: [`Template JSON syntax error: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    }
  }

  const validation = validateTemplateGraph(parsedJson)
  if (!validation.valid) {
    return {
      valid: false,
      filePath: resolvedPath,
      errors: validation.errors,
      warnings: validation.warnings,
    }
  }

  return {
    valid: true,
    filePath: resolvedPath,
    template: parsedJson as WorkflowTemplateV2,
    errors: [],
    warnings: validation.warnings,
  }
}

/**
 * Discovers and validates all custom workflow template files within designated directories.
 *
 * Searches designated directories (e.g. `<repo>/.forge/templates` and `<dataDir>/templates`).
 */
export async function discoverCustomTemplates(
  searchDirs: readonly string[],
): Promise<CustomTemplateDiscoveryResult> {
  const templates: WorkflowTemplateV2[] = []
  const errors: { path: string; error: string }[] = []
  const scannedDirs: string[] = []

  for (const dir of searchDirs) {
    const resolvedDir = resolve(dir)
    if (!existsSync(resolvedDir)) {
      continue
    }

    scannedDirs.push(resolvedDir)

    let entries: string[]
    try {
      entries = await readdir(resolvedDir)
    } catch (err) {
      errors.push({
        path: resolvedDir,
        error: `Failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    for (const entry of entries) {
      if (extname(entry).toLowerCase() !== '.json') {
        continue
      }

      const fullPath = join(resolvedDir, entry)
      const res = await validateCustomTemplateFile(fullPath)
      if (res.valid && res.template) {
        templates.push(res.template)
      } else {
        errors.push({
          path: fullPath,
          error: res.errors.join('; ') || 'Invalid template definition',
        })
      }
    }
  }

  return {
    templates,
    errors,
    scannedDirectories: scannedDirs,
  }
}

/**
 * Discovers custom workflow templates and registers them into the active TemplateV2Store.
 */
export async function registerCustomTemplates(
  store: TemplateV2Store,
  searchDirs: readonly string[],
): Promise<number> {
  const discovery = await discoverCustomTemplates(searchDirs)
  let count = 0
  for (const tmpl of discovery.templates) {
    store.save(tmpl)
    count++
  }
  return count
}

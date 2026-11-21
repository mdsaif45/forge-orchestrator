import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runIdSchema } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'
import { runGit } from '../git/exec'
import { parseUnifiedDiff } from './diffInspector'

export interface RollbackResult {
  readonly success: boolean
  readonly dryRun: boolean
  readonly appliedFiles: readonly string[]
  readonly reversePatch: string
  readonly error?: string | undefined
}

/**
 * Generates an exact inverse (reverse) unified git diff patch.
 *
 * Implements Axiom A3: Reversal is mathematically grounded in the hunk coordinates
 * and addition/deletion lines of the original diff patch.
 */
export function generateReversePatch(rawPatch: string): string {
  if (!rawPatch.trim()) {
    return ''
  }

  const lines = rawPatch.split(/\r?\n/)
  const out: string[] = []

  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) {
      continue
    }

    if (line.startsWith('diff --git ')) {
      inHunk = false
      // Swap paths if needed: diff --git a/file b/file
      out.push(line)
    } else if (line.startsWith('new file mode ')) {
      // In reverse, an added file becomes a deleted file
      out.push(line.replace('new file mode ', 'deleted file mode '))
    } else if (line.startsWith('deleted file mode ')) {
      // In reverse, a deleted file becomes a new file
      out.push(line.replace('deleted file mode ', 'new file mode '))
    } else if (line.startsWith('--- ')) {
      // Look ahead for +++ line
      const nextLine = lines[i + 1]
      if (nextLine?.startsWith('+++ ')) {
        const oldFrom = line.slice(4) // e.g. a/file or /dev/null
        const oldTo = nextLine.slice(4) // e.g. b/file or /dev/null

        if (oldFrom === '/dev/null') {
          // Was new file -> becomes deleted file
          out.push(`--- a/${oldTo.replace(/^b\//, '')}`)
          out.push('+++ /dev/null')
        } else if (oldTo === '/dev/null') {
          // Was deleted file -> becomes new file
          out.push('--- /dev/null')
          out.push(`+++ b/${oldFrom.replace(/^a\//, '')}`)
        } else {
          // Modified file
          out.push(`--- a/${oldTo.replace(/^b\//, '')}`)
          out.push(`+++ b/${oldFrom.replace(/^a\//, '')}`)
        }
        i++ // consume +++ line
      } else {
        out.push(line)
      }
    } else if (line.startsWith('@@ ')) {
      inHunk = true
      // Parse hunk header: @@ -fromStart[,fromLen] +toStart[,toLen] @@[ optional text]
      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
      if (hunkMatch) {
        const fromStart = hunkMatch[1] ?? '1'
        const fromLen = hunkMatch[2] !== undefined ? `,${hunkMatch[2]}` : ''
        const toStart = hunkMatch[3] ?? '1'
        const toLen = hunkMatch[4] !== undefined ? `,${hunkMatch[4]}` : ''
        const trailing = hunkMatch[5] ?? ''

        // Invert: + becomes -, - becomes +
        out.push(`@@ -${toStart}${toLen} +${fromStart}${fromLen} @@${trailing}`)
      } else {
        out.push(line)
      }
    } else if (inHunk && line.startsWith('+')) {
      // Invert added line to deleted line
      out.push(`-${line.slice(1)}`)
    } else if (inHunk && line.startsWith('-')) {
      // Invert deleted line to added line
      out.push(`+${line.slice(1)}`)
    } else {
      // Context lines (' '), headers, binary markers, or '\ No newline'
      out.push(line)
    }
  }

  return out.join('\n')
}

/**
 * Applies a reverse patch to a target repository, safely checking applicability first.
 */
export async function applyRollbackPatch(
  cwd: string,
  reversePatch: string,
  options?: { readonly dryRun?: boolean | undefined },
): Promise<RollbackResult> {
  const dryRun = options?.dryRun === true

  if (!reversePatch.trim()) {
    return {
      success: true,
      dryRun,
      appliedFiles: [],
      reversePatch,
    }
  }

  const { files } = parseUnifiedDiff(reversePatch)
  const appliedFiles = files.map((f) => f.path)

  // Create temporary patch file in an isolated temp directory
  const tempDir = await mkdtemp(join(tmpdir(), 'forge-revert-'))
  const patchPath = join(tempDir, 'revert.patch')

  try {
    await writeFile(patchPath, reversePatch, 'utf8')

    // Always run --check first to ensure patch applies cleanly (Axiom A2: Fail-closed)
    try {
      await runGit(['apply', '--check', patchPath], { cwd })
    } catch (checkErr) {
      return {
        success: false,
        dryRun,
        appliedFiles,
        reversePatch,
        error: `Reverse patch validation failed (conflicts or modified state): ${
          checkErr instanceof Error ? checkErr.message : String(checkErr)
        }`,
      }
    }

    if (!dryRun) {
      // Apply the patch for real
      await runGit(['apply', patchPath], { cwd })
    }

    return {
      success: true,
      dryRun,
      appliedFiles,
      reversePatch,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Finds authoritative diff/changeset artifact for a run and rolls it back.
 */
export async function rollbackRunChanges(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  runId: string,
  repoPath: string,
  options?: {
    readonly stepId?: string | undefined
    readonly dryRun?: boolean | undefined
  },
): Promise<RollbackResult> {
  const parsedRunId = runIdSchema.parse(runId)
  const artifacts = artifactStore.listForRun(parsedRunId)

  let filtered = artifacts
  if (options?.stepId) {
    filtered = filtered.filter((a) => a.stepId === options.stepId)
  }

  const diffArtifact =
    filtered.find((a) => a.kind === 'changeset' || a.kind === 'diff') ??
    artifacts.find((a) => a.kind === 'changeset' || a.kind === 'diff')

  if (!diffArtifact) {
    return {
      success: false,
      dryRun: options?.dryRun === true,
      appliedFiles: [],
      reversePatch: '',
      error: `No changeset or diff artifact found to rollback for run ${runId}`,
    }
  }

  const rawPatch = await artifactService.readArtifactText(diffArtifact.id)
  const reversePatch = generateReversePatch(rawPatch)

  return applyRollbackPatch(repoPath, reversePatch, { dryRun: options?.dryRun })
}

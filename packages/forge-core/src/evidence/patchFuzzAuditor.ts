import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * EVIDENCE-009: Changeset hunk boundary validator and patch fuzziness auditor.
 * Validates unified diff applicability against target files before modification (Axioms A1, A3).
 */

export type HunkStatus = 'clean' | 'fuzzy' | 'rejected'

export interface HunkAuditResult {
  readonly index: number
  readonly targetFile: string
  readonly oldStart: number
  readonly oldLength: number
  readonly newStart: number
  readonly newLength: number
  readonly offset: number
  readonly status: HunkStatus
  readonly reason?: string | undefined
}

export interface FileHunkAuditReport {
  readonly targetFile: string
  readonly hunksCount: number
  readonly status: HunkStatus
  readonly maxFuzz: number
  readonly hunks: readonly HunkAuditResult[]
}

export interface PatchFuzzReport {
  readonly valid: boolean
  readonly runId?: string | undefined
  readonly overallStatus: HunkStatus
  readonly filesCount: number
  readonly totalHunks: number
  readonly cleanHunks: number
  readonly fuzzyHunks: number
  readonly rejectedHunks: number
  readonly fileReports: readonly FileHunkAuditReport[]
  readonly formattedSummary: string
}

export interface PatchFuzzOptions {
  readonly runId?: string | undefined
  readonly cwd?: string | undefined
  readonly maxFuzz?: number | undefined
  readonly fileReader?: ((filePath: string) => Promise<string | null>) | undefined
}

interface ParsedHunk {
  index: number
  oldStart: number
  oldLength: number
  newStart: number
  newLength: number
  originalLines: string[]
}

interface ParsedFileDiff {
  sourceFile: string | null
  targetFile: string | null
  isNewFile: boolean
  isDeletedFile: boolean
  hunks: ParsedHunk[]
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/**
 * Parses raw unified git diff patch content into structured file and hunk representations.
 */
export function parseDiffHunks(diffText: string): ParsedFileDiff[] {
  const lines = diffText.split(/\r?\n/)
  const files: ParsedFileDiff[] = []

  let currentFile: ParsedFileDiff | null = null
  let currentHunk: ParsedHunk | null = null
  let hunkCounter = 0

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk)
        currentHunk = null
      }
      if (currentFile) {
        files.push(currentFile)
      }

      const match = /^diff --git a\/(.+?)\s+b\/(.+)$/.exec(line)
      currentFile = {
        sourceFile: match?.[1] ?? null,
        targetFile: match?.[2] ?? null,
        isNewFile: false,
        isDeletedFile: false,
        hunks: [],
      }
      hunkCounter = 0
      continue
    }

    if (!currentFile) {
      continue
    }

    if (line.startsWith('new file mode')) {
      currentFile.isNewFile = true
      continue
    }
    if (line.startsWith('deleted file mode')) {
      currentFile.isDeletedFile = true
      continue
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line)
    if (hunkMatch) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk)
      }
      hunkCounter++
      const oldStart = parseInt(hunkMatch[1] ?? '1', 10)
      const oldLength = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1
      const newStart = parseInt(hunkMatch[3] ?? '1', 10)
      const newLength = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1

      currentHunk = {
        index: hunkCounter,
        oldStart,
        oldLength,
        newStart,
        newLength,
        originalLines: [],
      }
      continue
    }

    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.originalLines.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        currentHunk.originalLines.push(line.slice(1))
      }
      // Note: additions ('+') do not exist in the original pre-image
    }
  }

  if (currentFile && currentHunk) {
    currentFile.hunks.push(currentHunk)
  }
  if (currentFile) {
    files.push(currentFile)
  }

  return files
}

/**
 * Checks if target file lines match expected hunk lines at a given line start offset.
 */
function matchesAt(
  targetLines: readonly string[],
  expected: readonly string[],
  startLine0: number,
): boolean {
  if (startLine0 < 0 || startLine0 + expected.length > targetLines.length) {
    return false
  }
  for (let i = 0; i < expected.length; i++) {
    if (targetLines[startLine0 + i] !== expected[i]) {
      return false
    }
  }
  return true
}

/**
 * Audits unified diff patch applicability and calculates hunk boundary fuzziness (Axioms A1, A3).
 */
export async function auditPatchFuzziness(
  diffText: string,
  options: PatchFuzzOptions = {},
): Promise<PatchFuzzReport> {
  const maxFuzz = options.maxFuzz ?? 5
  const cwd = resolve(options.cwd ?? process.cwd())

  const defaultFileReader = async (filePath: string): Promise<string | null> => {
    const fullPath = resolve(cwd, filePath)
    if (!existsSync(fullPath)) {
      return null
    }
    return readFile(fullPath, 'utf8')
  }

  const reader = options.fileReader ?? defaultFileReader
  const parsedFiles = parseDiffHunks(diffText)

  const fileReports: FileHunkAuditReport[] = []
  let totalHunks = 0
  let cleanHunks = 0
  let fuzzyHunks = 0
  let rejectedHunks = 0

  for (const file of parsedFiles) {
    const targetPath = file.targetFile ?? file.sourceFile ?? 'unknown'
    const hunkResults: HunkAuditResult[] = []

    if (file.isNewFile) {
      // New files are clean by definition if not already existing
      fileReports.push({
        targetFile: targetPath,
        hunksCount: 0,
        status: 'clean',
        maxFuzz: 0,
        hunks: [],
      })
      continue
    }

    const fileContent = await reader(targetPath)
    if (fileContent === null) {
      // Target file does not exist on disk
      const rejectedResult: HunkAuditResult = {
        index: 1,
        targetFile: targetPath,
        oldStart: 0,
        oldLength: 0,
        newStart: 0,
        newLength: 0,
        offset: 0,
        status: 'rejected',
        reason: `Target file "${targetPath}" not found on disk`,
      }
      rejectedHunks += Math.max(1, file.hunks.length)
      totalHunks += Math.max(1, file.hunks.length)
      fileReports.push({
        targetFile: targetPath,
        hunksCount: file.hunks.length,
        status: 'rejected',
        maxFuzz: 0,
        hunks: [rejectedResult],
      })
      continue
    }

    const targetLines = fileContent.split(/\r?\n/)
    let fileHasRejection = false
    let fileMaxFuzz = 0

    for (const hunk of file.hunks) {
      totalHunks++
      const expectedOld = hunk.originalLines
      const nominalIndex0 = Math.max(0, hunk.oldStart - 1)

      // 1. Check exact match (offset 0)
      if (matchesAt(targetLines, expectedOld, nominalIndex0)) {
        cleanHunks++
        hunkResults.push({
          index: hunk.index,
          targetFile: targetPath,
          oldStart: hunk.oldStart,
          oldLength: hunk.oldLength,
          newStart: hunk.newStart,
          newLength: hunk.newLength,
          offset: 0,
          status: 'clean',
        })
        continue
      }

      // 2. Search within maxFuzz radius
      let matchedOffset: number | null = null
      for (let delta = 1; delta <= maxFuzz; delta++) {
        // Check +delta
        if (matchesAt(targetLines, expectedOld, nominalIndex0 + delta)) {
          matchedOffset = delta
          break
        }
        // Check -delta
        if (matchesAt(targetLines, expectedOld, nominalIndex0 - delta)) {
          matchedOffset = -delta
          break
        }
      }

      if (matchedOffset !== null) {
        fuzzyHunks++
        const absOffset = Math.abs(matchedOffset)
        fileMaxFuzz = Math.max(fileMaxFuzz, absOffset)
        hunkResults.push({
          index: hunk.index,
          targetFile: targetPath,
          oldStart: hunk.oldStart,
          oldLength: hunk.oldLength,
          newStart: hunk.newStart,
          newLength: hunk.newLength,
          offset: matchedOffset,
          status: 'fuzzy',
          reason: `Matched with line offset drift of ${matchedOffset > 0 ? `+${String(matchedOffset)}` : String(matchedOffset)} lines`,
        })
      } else {
        rejectedHunks++
        fileHasRejection = true
        hunkResults.push({
          index: hunk.index,
          targetFile: targetPath,
          oldStart: hunk.oldStart,
          oldLength: hunk.oldLength,
          newStart: hunk.newStart,
          newLength: hunk.newLength,
          offset: 0,
          status: 'rejected',
          reason: `Original context lines not found within fuzz radius of +/-${String(maxFuzz)} lines`,
        })
      }
    }

    const fileStatus: HunkStatus = fileHasRejection
      ? 'rejected'
      : fileMaxFuzz > 0
        ? 'fuzzy'
        : 'clean'

    fileReports.push({
      targetFile: targetPath,
      hunksCount: file.hunks.length,
      status: fileStatus,
      maxFuzz: fileMaxFuzz,
      hunks: hunkResults,
    })
  }

  const overallStatus: HunkStatus =
    rejectedHunks > 0 ? 'rejected' : fuzzyHunks > 0 ? 'fuzzy' : 'clean'

  const lines: string[] = [
    'PATCH HUNK FUZZINESS AUDIT (EVIDENCE-009):',
    `  Overall Status:  ${overallStatus.toUpperCase()}`,
    `  Files Audited:   ${String(fileReports.length)}`,
    `  Total Hunks:     ${String(totalHunks)}`,
    `  Clean Hunks:     ${String(cleanHunks)}`,
    `  Fuzzy Hunks:     ${String(fuzzyHunks)}`,
    `  Rejected Hunks:  ${String(rejectedHunks)}`,
  ]

  for (const fr of fileReports) {
    lines.push(
      `  • [${fr.targetFile}] status: ${fr.status} (hunks: ${String(fr.hunksCount)}, max fuzz: ${String(fr.maxFuzz)})`,
    )
    for (const h of fr.hunks) {
      if (h.status !== 'clean') {
        lines.push(
          `      Hunk #${String(h.index)} @@ -${String(h.oldStart)},${String(h.oldLength)} @@: ${h.status} (${h.reason ?? ''})`,
        )
      }
    }
  }

  return {
    valid: rejectedHunks === 0,
    runId: options.runId,
    overallStatus,
    filesCount: fileReports.length,
    totalHunks,
    cleanHunks,
    fuzzyHunks,
    rejectedHunks,
    fileReports,
    formattedSummary: lines.join('\n'),
  }
}

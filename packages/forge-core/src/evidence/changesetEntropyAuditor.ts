export type EntropyViolationType = 'high_entropy_blob' | 'oversized_line' | 'excessive_hunk_size'

export interface EntropyAuditViolation {
  type: EntropyViolationType
  file: string
  hunkIndex: number
  metricValue: number
  threshold: number
  snippet?: string | undefined
}

export interface EntropyAuditConfig {
  maxHunkEntropy?: number | undefined
  maxLineLength?: number | undefined
  maxHunkBytes?: number | undefined
}

export interface EntropyAuditReport {
  isSafe: boolean
  overallEntropy: number
  violations: EntropyAuditViolation[]
  hunksAudited: number
  totalBytes: number
  summary: string
}

export function calculateShannonEntropy(input: string): number {
  if (!input || input.length === 0) {
    return 0
  }

  const freqMap = new Map<string, number>()
  for (const char of input) {
    freqMap.set(char, (freqMap.get(char) ?? 0) + 1)
  }

  const len = input.length
  let entropy = 0

  for (const count of freqMap.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }

  // Rounded to 3 decimal places
  return Math.round(entropy * 1000) / 1000
}

export function auditChangesetEntropy(
  patchContent: string,
  config?: EntropyAuditConfig,
): EntropyAuditReport {
  const maxHunkEntropy = config?.maxHunkEntropy ?? 5.8
  const maxLineLength = config?.maxLineLength ?? 1000
  const maxHunkBytes = config?.maxHunkBytes ?? 65_536

  const violations: EntropyAuditViolation[] = []
  let hunksAudited = 0
  let currentFile = 'unknown'
  let hunkIndex = 0

  const lines = patchContent.split(/\r?\n/)
  let currentHunkLines: string[] = []

  const flushHunk = (): void => {
    if (currentHunkLines.length === 0) {
      return
    }
    hunksAudited += 1
    const hunkText = currentHunkLines.join('\n')
    const hunkByteSize = Buffer.byteLength(hunkText, 'utf8')
    const hunkEntropy = calculateShannonEntropy(hunkText)

    if (hunkByteSize > maxHunkBytes) {
      violations.push({
        type: 'excessive_hunk_size',
        file: currentFile,
        hunkIndex,
        metricValue: hunkByteSize,
        threshold: maxHunkBytes,
        snippet: currentHunkLines[0]?.slice(0, 80),
      })
    }

    if (hunkEntropy > maxHunkEntropy && hunkText.length > 64) {
      violations.push({
        type: 'high_entropy_blob',
        file: currentFile,
        hunkIndex,
        metricValue: hunkEntropy,
        threshold: maxHunkEntropy,
        snippet: currentHunkLines[0]?.slice(0, 80),
      })
    }

    currentHunkLines = []
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('+++ b/')) {
      flushHunk()
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim()
      } else if (line.startsWith('diff --git ')) {
        const parts = line.split(' ')
        if (parts[3]?.startsWith('b/')) {
          currentFile = parts[3].slice(2)
        }
      }
      hunkIndex = 0
    } else if (line.startsWith('@@ ')) {
      flushHunk()
      hunkIndex += 1
      currentHunkLines.push(line)
    } else {
      if (currentHunkLines.length > 0) {
        if (line.length > maxLineLength) {
          violations.push({
            type: 'oversized_line',
            file: currentFile,
            hunkIndex,
            metricValue: line.length,
            threshold: maxLineLength,
            snippet: line.slice(0, 80) + '...',
          })
        }
        currentHunkLines.push(line)
      }
    }
  }

  flushHunk()

  const overallEntropy = calculateShannonEntropy(patchContent)
  const totalBytes = Buffer.byteLength(patchContent, 'utf8')
  const isSafe = violations.length === 0

  const summary = isSafe
    ? `Entropy audit passed: ${String(hunksAudited)} hunks audited across ${String(totalBytes)} bytes (entropy: ${String(overallEntropy)}).`
    : `Entropy audit flagged ${String(violations.length)} violation(s) across ${String(hunksAudited)} hunks.`

  return {
    isSafe,
    overallEntropy,
    violations,
    hunksAudited,
    totalBytes,
    summary,
  }
}

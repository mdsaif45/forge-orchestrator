export type HunkContextPriority = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ParsedDiffHunk {
  file: string
  fileHeader: string
  hunkHeader: string
  lines: string[]
  estimatedTokens: number
  priority: HunkContextPriority
}

export interface ContextBudgetSlicerConfig {
  maxTokenBudget: number
  charsPerToken?: number | undefined
  reserveHeaderTokens?: number | undefined
}

export interface ContextBudgetSliceReport {
  originalTokens: number
  slicedTokens: number
  totalHunks: number
  retainedHunks: number
  omittedHunks: number
  slicedDiff: string
  isTruncated: boolean
  summary: string
}

function estimateTokens(text: string, charsPerToken: number): number {
  if (!text || text.length === 0) {
    return 0
  }
  return Math.max(1, Math.ceil(text.length / charsPerToken))
}

function classifyHunkPriority(lines: string[]): HunkContextPriority {
  const text = lines.join('\n')
  if (
    /export\s+(function|class|interface|type|const|enum)/i.test(text) ||
    /(it|test|describe)\s*\(/i.test(text) ||
    /public\s+(static\s+)?(async\s+)?[a-zA-Z0-9_]+\s*\(/i.test(text)
  ) {
    return 'HIGH'
  }
  if (lines.some((l) => l.startsWith('+') || l.startsWith('-'))) {
    return 'MEDIUM'
  }
  return 'LOW'
}

export function sliceChangesetForContextBudget(
  patchContent: string,
  config: ContextBudgetSlicerConfig | number,
): ContextBudgetSliceReport {
  const resolvedConfig: ContextBudgetSlicerConfig =
    typeof config === 'number' ? { maxTokenBudget: config } : config
  const charsPerToken = Math.max(1, resolvedConfig.charsPerToken ?? 4)
  const maxTokenBudget = Math.max(20, resolvedConfig.maxTokenBudget)

  const originalTokens = estimateTokens(patchContent, charsPerToken)

  if (originalTokens <= maxTokenBudget) {
    return {
      originalTokens,
      slicedTokens: originalTokens,
      totalHunks: (patchContent.match(/@@\s+-[0-9,]+\s+\+[0-9,]+\s+@@/g) ?? []).length,
      retainedHunks: (patchContent.match(/@@\s+-[0-9,]+\s+\+[0-9,]+\s+@@/g) ?? []).length,
      omittedHunks: 0,
      slicedDiff: patchContent,
      isTruncated: false,
      summary: `Full patch fits within budget (${String(originalTokens)} / ${String(maxTokenBudget)} tokens).`,
    }
  }

  // Parse patch into hunks
  const lines = patchContent.split(/\r?\n/)
  const hunks: ParsedDiffHunk[] = []

  let currentFile = 'unknown'
  let currentFileHeaderLines: string[] = []
  let currentHunkHeader = ''
  let currentHunkLines: string[] = []

  const flushHunk = (): void => {
    if (currentHunkLines.length > 0 && currentHunkHeader.length > 0) {
      const fullHunkText = `${currentHunkHeader}\n${currentHunkLines.join('\n')}`
      const tokens = estimateTokens(fullHunkText, charsPerToken)
      hunks.push({
        file: currentFile,
        fileHeader: currentFileHeaderLines.join('\n'),
        hunkHeader: currentHunkHeader,
        lines: [...currentHunkLines],
        estimatedTokens: tokens,
        priority: classifyHunkPriority(currentHunkLines),
      })
      currentHunkLines = []
      currentHunkHeader = ''
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      if (line.startsWith('diff --git ')) {
        flushHunk()
        currentFileHeaderLines = [line]
        const parts = line.split(' ')
        currentFile = parts[3]?.slice(2) ?? 'unknown'
      } else {
        currentFileHeaderLines.push(line)
      }
    } else if (line.startsWith('@@ ')) {
      flushHunk()
      currentHunkHeader = line
    } else {
      if (currentHunkHeader.length > 0) {
        currentHunkLines.push(line)
      }
    }
  }
  flushHunk()

  // Assemble sliced diff within budget
  let currentBudgetRemaining = maxTokenBudget
  const outputParts: string[] = []
  let retainedHunks = 0
  let omittedHunks = 0
  const filesIncluded = new Set<string>()

  for (const hunk of hunks) {
    const needFileHeader = !filesIncluded.has(hunk.file)
    const fileHeaderTokens = needFileHeader
      ? estimateTokens(`${hunk.fileHeader}\n`, charsPerToken)
      : 0
    const requiredTokens = fileHeaderTokens + hunk.estimatedTokens

    if (currentBudgetRemaining >= requiredTokens) {
      if (needFileHeader && hunk.fileHeader.length > 0) {
        outputParts.push(hunk.fileHeader)
        filesIncluded.add(hunk.file)
      }
      outputParts.push(hunk.hunkHeader)
      outputParts.push(...hunk.lines)
      currentBudgetRemaining -= requiredTokens
      retainedHunks += 1
    } else {
      omittedHunks += 1
      if (needFileHeader && hunk.fileHeader.length > 0) {
        outputParts.push(hunk.fileHeader)
        filesIncluded.add(hunk.file)
      }
      outputParts.push(
        `# [Hunk omitted: ${hunk.hunkHeader} (~${String(hunk.estimatedTokens)} tokens) omitted to satisfy token budget]`,
      )
    }
  }

  const slicedDiff = outputParts.join('\n')
  const slicedTokens = estimateTokens(slicedDiff, charsPerToken)

  return {
    originalTokens,
    slicedTokens,
    totalHunks: hunks.length,
    retainedHunks,
    omittedHunks,
    slicedDiff,
    isTruncated: omittedHunks > 0,
    summary: `Sliced patch to fit budget: retained ${String(retainedHunks)}/${String(hunks.length)} hunks (${String(slicedTokens)} / ${String(maxTokenBudget)} tokens).`,
  }
}

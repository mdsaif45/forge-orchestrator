/**
 * EVIDENCE-016: Changeset Semantic Diff Chunker & AST-Aware Change Summary Extractor.
 *
 * Partitions raw unified git diffs into structured semantic change hunks categorized by intent
 * (schema mutation, core logic, test assertions, build configuration, documentation)
 * and calculates blast radius risk assessments.
 */

export type SemanticCategory =
  'SCHEMA_MUTATION' | 'CORE_LOGIC' | 'TEST_SUITE' | 'BUILD_CONFIG' | 'DOCUMENTATION' | 'UNKNOWN'

export interface SemanticDiffChunk {
  chunkId: string
  filePath: string
  category: SemanticCategory
  header: string
  startLine: number
  lineCount: number
  addedLinesCount: number
  deletedLinesCount: number
  modifiedSymbols: string[]
  riskScore: number // 0 to 100
  summary: string
}

export interface SemanticDiffReport {
  chunks: SemanticDiffChunk[]
  totalChunks: number
  totalAdded: number
  totalDeleted: number
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  dominantCategory: SemanticCategory
  isTruncated: boolean
}

export interface SemanticChunkingOptions {
  maxChunks?: number
}

const DEFAULT_MAX_CHUNKS = 50

/**
 * Classifies a file path into its structural/semantic category.
 */
export function classifyFilePath(filePath: string): SemanticCategory {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()

  if (
    normalized.includes('schema') ||
    normalized.includes('migration') ||
    normalized.includes('/db/') ||
    normalized.endsWith('.sql')
  ) {
    return 'SCHEMA_MUTATION'
  }

  if (
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/')
  ) {
    return 'TEST_SUITE'
  }

  if (
    normalized.endsWith('package.json') ||
    normalized.endsWith('tsconfig.json') ||
    normalized.includes('tsconfig.') ||
    normalized.endsWith('.eslintrc') ||
    normalized.endsWith('.eslintrc.json') ||
    normalized.endsWith('.prettierrc') ||
    normalized.endsWith('.toml') ||
    normalized.endsWith('dockerfile') ||
    normalized.endsWith('.yaml') ||
    normalized.endsWith('.yml')
  ) {
    return 'BUILD_CONFIG'
  }

  if (
    normalized.endsWith('.md') ||
    normalized.endsWith('.txt') ||
    normalized.endsWith('.rst') ||
    normalized.includes('/docs/')
  ) {
    return 'DOCUMENTATION'
  }

  if (
    normalized.endsWith('.ts') ||
    normalized.endsWith('.tsx') ||
    normalized.endsWith('.js') ||
    normalized.endsWith('.jsx') ||
    normalized.endsWith('.py') ||
    normalized.endsWith('.rs') ||
    normalized.endsWith('.go')
  ) {
    return 'CORE_LOGIC'
  }

  return 'UNKNOWN'
}

/**
 * Calculates a risk score (0-100) based on category and change volume.
 */
function calculateChunkRisk(category: SemanticCategory, added: number, deleted: number): number {
  const baseCategoryWeight: Record<SemanticCategory, number> = {
    SCHEMA_MUTATION: 80,
    BUILD_CONFIG: 65,
    CORE_LOGIC: 50,
    TEST_SUITE: 20,
    DOCUMENTATION: 5,
    UNKNOWN: 40,
  }

  const base = baseCategoryWeight[category]
  const volumePenalty = Math.min(20, Math.floor((added + deleted) / 5))
  return Math.min(100, base + volumePenalty)
}

/**
 * Extracts TypeScript/JavaScript function, class, or interface symbol names from diff line.
 */
function extractSymbolName(line: string): string | null {
  const funcMatch = /(?:function|class|interface|type|const|let|var)\s+([a-zA-Z0-9_$]+)/.exec(line)
  if (funcMatch?.[1]) {
    return funcMatch[1]
  }
  return null
}

/**
 * Parses raw unified diff string into structured semantic chunks.
 */
export function chunkUnifiedDiff(
  rawDiff: string,
  options: SemanticChunkingOptions = {},
): SemanticDiffReport {
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS

  if (!rawDiff.trim()) {
    return {
      chunks: [],
      totalChunks: 0,
      totalAdded: 0,
      totalDeleted: 0,
      overallRisk: 'LOW',
      dominantCategory: 'DOCUMENTATION',
      isTruncated: false,
    }
  }

  const lines = rawDiff.split(/\r?\n/)
  const chunks: SemanticDiffChunk[] = []
  let currentFile = 'unknown'
  let currentChunk: Partial<SemanticDiffChunk> | null = null
  let chunkIndex = 0

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const parts = line.split(' ')
      const filePart = parts[3]
      if (filePart) {
        currentFile = filePart.replace(/^b\//, '')
      }
      continue
    }

    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6)
      continue
    }

    if (line.startsWith('@@ ')) {
      // Finalize prior chunk
      if (currentChunk?.filePath) {
        chunks.push(finalizeChunk(currentChunk as SemanticDiffChunk))
      }

      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)/.exec(line)
      const startLinePart = match?.[2]
      const startLine = startLinePart ? parseInt(startLinePart, 10) : 1
      const lineCountPart = match?.[3]
      const lineCount = lineCountPart ? parseInt(lineCountPart, 10) : 1
      const header = match?.[4]?.trim() ?? ''

      chunkIndex++
      currentChunk = {
        chunkId: `chunk-${String(chunkIndex)}`,
        filePath: currentFile,
        category: classifyFilePath(currentFile),
        header,
        startLine,
        lineCount,
        addedLinesCount: 0,
        deletedLinesCount: 0,
        modifiedSymbols: [],
      }
      continue
    }

    if (currentChunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentChunk.addedLinesCount = (currentChunk.addedLinesCount ?? 0) + 1
        const symbol = extractSymbolName(line.slice(1))
        if (symbol && !currentChunk.modifiedSymbols?.includes(symbol)) {
          currentChunk.modifiedSymbols?.push(symbol)
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentChunk.deletedLinesCount = (currentChunk.deletedLinesCount ?? 0) + 1
        const symbol = extractSymbolName(line.slice(1))
        if (symbol && !currentChunk.modifiedSymbols?.includes(symbol)) {
          currentChunk.modifiedSymbols?.push(symbol)
        }
      }
    }
  }

  if (currentChunk?.filePath) {
    chunks.push(finalizeChunk(currentChunk as SemanticDiffChunk))
  }

  const isTruncated = chunks.length > maxChunks
  const boundedChunks = chunks.slice(0, maxChunks)

  let totalAdded = 0
  let totalDeleted = 0
  const categoryCounts: Record<SemanticCategory, number> = {
    SCHEMA_MUTATION: 0,
    CORE_LOGIC: 0,
    TEST_SUITE: 0,
    BUILD_CONFIG: 0,
    DOCUMENTATION: 0,
    UNKNOWN: 0,
  }

  let maxRiskScore = 0
  for (const c of boundedChunks) {
    totalAdded += c.addedLinesCount
    totalDeleted += c.deletedLinesCount
    categoryCounts[c.category] = categoryCounts[c.category] + 1
    if (c.riskScore > maxRiskScore) {
      maxRiskScore = c.riskScore
    }
  }

  let dominantCategory: SemanticCategory = 'CORE_LOGIC'
  let maxCount = -1
  for (const [cat, count] of Object.entries(categoryCounts) as [SemanticCategory, number][]) {
    if (count > maxCount) {
      maxCount = count
      dominantCategory = cat
    }
  }

  let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW'
  if (maxRiskScore >= 85) {
    overallRisk = 'CRITICAL'
  } else if (maxRiskScore >= 65) {
    overallRisk = 'HIGH'
  } else if (maxRiskScore >= 40) {
    overallRisk = 'MEDIUM'
  }

  return {
    chunks: boundedChunks,
    totalChunks: boundedChunks.length,
    totalAdded,
    totalDeleted,
    overallRisk,
    dominantCategory,
    isTruncated,
  }
}

function finalizeChunk(chunk: SemanticDiffChunk): SemanticDiffChunk {
  const added = chunk.addedLinesCount
  const deleted = chunk.deletedLinesCount
  const symbols = chunk.modifiedSymbols
  const riskScore = calculateChunkRisk(chunk.category, added, deleted)

  const symbolSummary = symbols.length > 0 ? ` (symbols: ${symbols.join(', ')})` : ''
  const summary = `[${chunk.category}] ${chunk.filePath} +${String(added)}/-${String(deleted)}${symbolSummary}`

  return {
    ...chunk,
    addedLinesCount: added,
    deletedLinesCount: deleted,
    modifiedSymbols: symbols,
    riskScore,
    summary,
  }
}

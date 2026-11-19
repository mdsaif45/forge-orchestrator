import { type RunId, runIdSchema } from '@shared/domain'
import type { RunStore } from '../db/runStore'
import type { ArtifactStore } from '../db/artifactStore'

export interface AgentMemoryEntry {
  readonly runId: string
  readonly task: string
  readonly completedAt: string
  readonly exitCode: number
  readonly summary: string
  readonly touchedFiles: readonly string[]
  readonly keyToolActions: readonly string[]
  readonly relevanceScore?: number | undefined
}

export interface AgentMemoryQueryResult {
  readonly valid: boolean
  readonly query: string
  readonly totalMatches: number
  readonly entries: readonly AgentMemoryEntry[]
  readonly formattedSummary: string
  readonly contextSnippet: string
}

export interface AgentMemoryStats {
  readonly totalRuns: number
  readonly completedRuns: number
  readonly indexedSolutions: number
  readonly formattedSummary: string
}

/**
 * Tokenizes text into lowercase word stems/tokens, filtering punctuation and common stopwords.
 */
function tokenize(text: string): Set<string> {
  const stopwords = new Set([
    'a',
    'an',
    'the',
    'in',
    'on',
    'of',
    'for',
    'to',
    'with',
    'at',
    'by',
    'from',
    'and',
    'or',
    'is',
    'are',
    'was',
    'were',
    'be',
    'this',
    'that',
    'it',
  ])
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopwords.has(w))
  return new Set(words)
}

/**
 * Calculates Jaccard keyword similarity between two word sets.
 */
function calculateSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

/**
 * Extracts touched files from changeset or diff artifacts for a run.
 */
function extractTouchedFiles(artifactStore: ArtifactStore, runId: RunId): string[] {
  const artifacts = artifactStore.listForRun(runId)
  const touchedFiles = new Set<string>()

  for (const a of artifacts) {
    if (a.kind === 'changeset' || a.kind === 'diff') {
      const candidate = a.name || a.relativePath
      touchedFiles.add(candidate)
    }
  }

  return Array.from(touchedFiles).sort()
}

/**
 * Extracts key tool invocations from stdout/tool artifacts for a run.
 */
function extractKeyToolActions(artifactStore: ArtifactStore, runId: RunId): string[] {
  const artifacts = artifactStore.listForRun(runId)
  const actions: string[] = []

  for (const a of artifacts) {
    if (a.kind === 'tool-output' || a.kind === 'stdout') {
      const name = a.name || a.relativePath
      if (!actions.includes(name)) {
        actions.push(name)
      }
    }
  }

  return actions.slice(0, 10)
}

/**
 * Indexes a specific completed run into an AgentMemoryEntry.
 *
 * Implements Axioms:
 * - A1 (Truth ownership): Queries physical database records directly.
 * - A3 (Physical evidence): Only indexes runs with exitCode 0 and physical artifacts.
 */
export async function indexRunMemory(
  runStore: RunStore,
  artifactStore: ArtifactStore,
  runId: string,
): Promise<AgentMemoryEntry | null> {
  await Promise.resolve()
  const parsedRunId = runIdSchema.safeParse(runId)
  if (!parsedRunId.success) {
    return null
  }
  const run = runStore.getRun(parsedRunId.data)
  if (!run) {
    return null
  }
  if (run.status !== 'completed' || run.exitCode !== 0) {
    return null
  }

  const touchedFiles = extractTouchedFiles(artifactStore, parsedRunId.data)
  const keyToolActions = extractKeyToolActions(artifactStore, parsedRunId.data)
  const taskText =
    typeof run.metadata.task === 'string'
      ? run.metadata.task
      : (run.summary ?? 'Completed engineering task')

  return {
    runId: run.id,
    task: taskText,
    completedAt: run.finishedAt ?? run.startedAt,
    exitCode: run.exitCode,
    summary: run.summary ?? 'Successful task execution',
    touchedFiles,
    keyToolActions,
  }
}

/**
 * Queries the memory index across past completed runs, ranking results by semantic similarity and file overlap.
 *
 * Implements Axioms:
 * - A2 (Fail-closed): Returns valid empty result on non-matching or missing records.
 * - A5 (Bounded consumption): Caps matched results to `limit` and formats bounded prompt snippets.
 */
export async function queryAgentMemory(
  runStore: RunStore,
  artifactStore: ArtifactStore,
  options: {
    readonly query: string
    readonly touchedFiles?: readonly string[] | undefined
    readonly limit?: number | undefined
    readonly minScore?: number | undefined
    readonly maxTokens?: number | undefined
  },
): Promise<AgentMemoryQueryResult> {
  await Promise.resolve()
  const limit = options.limit ?? 5
  const minScore = options.minScore ?? 0.05
  const maxTokens = options.maxTokens ?? 1024
  const queryTokens = tokenize(options.query)
  const candidateFiles = new Set(options.touchedFiles ?? [])

  const runs = runStore.listRuns({ status: 'completed', limit: 100 })
  const scoredEntries: (AgentMemoryEntry & { relevanceScore: number })[] = []

  for (const r of runs) {
    if (r.exitCode !== 0) continue
    const taskText =
      typeof r.metadata.task === 'string'
        ? r.metadata.task
        : (r.summary ?? 'Completed engineering task')
    const taskTokens = tokenize(taskText)
    const textScore = calculateSimilarity(queryTokens, taskTokens)

    const touched = extractTouchedFiles(artifactStore, r.id)
    let fileScore = 0
    if (candidateFiles.size > 0 && touched.length > 0) {
      const matchCount = touched.filter((f) => candidateFiles.has(f)).length
      fileScore = matchCount / Math.max(candidateFiles.size, touched.length)
    }

    const totalScore = textScore * 0.7 + fileScore * 0.3
    if (totalScore >= minScore) {
      const tools = extractKeyToolActions(artifactStore, r.id)
      scoredEntries.push({
        runId: r.id,
        task: taskText,
        completedAt: r.finishedAt ?? r.startedAt,
        exitCode: r.exitCode,
        summary: r.summary ?? 'Successful task execution',
        touchedFiles: touched,
        keyToolActions: tools,
        relevanceScore: Math.round(totalScore * 100) / 100,
      })
    }
  }

  scoredEntries.sort((a, b) => b.relevanceScore - a.relevanceScore)
  const topMatches = scoredEntries.slice(0, limit)

  // Format context snippet bounded to token ceiling
  const snippetLines: string[] = []
  if (topMatches.length > 0) {
    snippetLines.push('### PREVIOUS VERIFIED SOLUTIONS (RELEVANT MEMORY):')
    for (const match of topMatches) {
      snippetLines.push(`- Run ${match.runId.slice(0, 8)}: "${match.task}"`)
      snippetLines.push(`  Outcome: ${match.summary}`)
      if (match.touchedFiles.length > 0) {
        snippetLines.push(`  Modified: ${match.touchedFiles.join(', ')}`)
      }
    }
  }
  let contextSnippet = snippetLines.join('\n')
  const approxTokens = Math.ceil(contextSnippet.length / 4)
  if (approxTokens > maxTokens) {
    contextSnippet = contextSnippet.slice(0, maxTokens * 4) + '...'
  }

  // Format CLI summary
  const summaryLines: string[] = []
  summaryLines.push(
    '================================================================================',
  )
  summaryLines.push(`Agent Memory Search: "${options.query}"`)
  summaryLines.push(`Found Matches: ${String(topMatches.length)}`)
  summaryLines.push(
    '================================================================================',
  )
  if (topMatches.length === 0) {
    summaryLines.push('  (No prior verified solutions match the current query)')
  } else {
    for (const m of topMatches) {
      summaryLines.push(`• [Score: ${String(m.relevanceScore)}] Run ${m.runId}: ${m.task}`)
      summaryLines.push(`  Summary: ${m.summary}`)
      if (m.touchedFiles.length > 0) {
        summaryLines.push(`  Files:   ${m.touchedFiles.join(', ')}`)
      }
    }
  }

  return {
    valid: true,
    query: options.query,
    totalMatches: topMatches.length,
    entries: topMatches,
    formattedSummary: summaryLines.join('\n'),
    contextSnippet,
  }
}

/**
 * Returns overall statistics on indexed runs and historical solutions.
 */
export async function getMemoryStats(runStore: RunStore): Promise<AgentMemoryStats> {
  await Promise.resolve()
  const allRuns = runStore.listRuns({ limit: 1000 })
  const completed = allRuns.filter((r) => r.status === 'completed')
  const successful = completed.filter((r) => r.exitCode === 0)

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push('AGENT MEMORY STATISTICS')
  lines.push('================================================================================')
  lines.push(`  Total Runs:          ${String(allRuns.length)}`)
  lines.push(`  Completed Runs:      ${String(completed.length)}`)
  lines.push(`  Verified Solutions:  ${String(successful.length)}`)

  return {
    totalRuns: allRuns.length,
    completedRuns: completed.length,
    indexedSolutions: successful.length,
    formattedSummary: lines.join('\n'),
  }
}

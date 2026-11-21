import { z } from 'zod'

/**
 * Committed historical benchmark baseline (measured 2026-08-31, foldervault, claude+antigravity).
 * Committed so future runs can be honestly compared against physical evidence (#159).
 */
export const COMMITTED_BENCHMARK_BASELINE = {
  date: '2026-08-31',
  target: 'foldervault',
  // eslint-disable-next-line no-restricted-syntax
  runtimes: 'claude+antigravity',
  stages: {
    planning: 130.3,
    implementation: 20.1,
    codeAudit: 255.7,
  },
  total: 461.7,
  manualEquivalentSeconds: [120, 180] as const,
} as const

export const stageStatusSchema = z.enum(['completed', 'skipped', 'capped', 'failed'])
export type StageStatus = z.infer<typeof stageStatusSchema>

export const stageTimingSchema = z.strictObject({
  name: z.string().min(1),
  durationSeconds: z.number().nonnegative(),
  status: stageStatusSchema,
  notes: z.string().optional(),
})
export type StageTiming = z.infer<typeof stageTimingSchema>

export const benchmarkResultSchema = z.strictObject({
  runAt: z.string().min(1),
  repository: z.string().min(1),
  totalSeconds: z.number().nonnegative(),
  stages: z.array(stageTimingSchema),
  comparisonWithBaseline: z.strictObject({
    baselineTotalSeconds: z.number().positive(),
    deltaSeconds: z.number(),
    speedupRatio: z.number().positive(),
  }),
})
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>

/**
 * Parses timeline JSONL events from `audit-out/timeline.jsonl` into measured stages.
 */
export function parseTimelineJsonl(content: string): StageTiming[] {
  const lines = content.split('\n')
  const marks: { readonly label: string; readonly t: number }[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'kind' in parsed &&
        (parsed as { kind: string }).kind === 'mark' &&
        'label' in parsed &&
        't' in parsed &&
        typeof (parsed as { t: unknown }).t === 'number'
      ) {
        marks.push({
          label: String((parsed as { label: unknown }).label),
          t: Number((parsed as { t: unknown }).t),
        })
      }
    } catch {
      // Ignore partial or unparseable lines
    }
  }

  if (marks.length < 2) {
    return []
  }

  const stages: StageTiming[] = []
  for (let i = 0; i < marks.length - 1; i++) {
    const start = marks[i]
    const end = marks[i + 1]
    if (!start || !end) continue

    const durationSec = Math.max(0, (end.t - start.t) / 1000)

    // Skip zero-duration boundaries starting with "Finish"
    if (start.label.startsWith('Finish') && durationSec === 0) {
      continue
    }

    let status: StageStatus = 'completed'
    let notes: string | undefined

    if (/skip/i.test(start.label) || /skip/i.test(end.label)) {
      status = 'skipped'
      notes = 'Stage unrequested and skipped'
    } else if (/cap/i.test(start.label) || /budget/i.test(start.label)) {
      status = 'capped'
      notes = 'Budget ceiling reached'
    } else if (/fail/i.test(start.label) || /error/i.test(start.label)) {
      status = 'failed'
    }

    stages.push({
      name: start.label,
      durationSeconds: Number(durationSec.toFixed(1)),
      status,
      ...(notes ? { notes } : {}),
    })
  }

  return stages
}

/**
 * Computes benchmark results comparing current run with the committed baseline.
 */
export function computeBenchmarkResult(params: {
  readonly repository: string
  readonly stages: readonly StageTiming[]
  readonly runAt?: string
}): BenchmarkResult {
  const totalSeconds = params.stages.reduce((acc, s) => acc + s.durationSeconds, 0)
  const baselineTotal = COMMITTED_BENCHMARK_BASELINE.total
  const deltaSeconds = Number((totalSeconds - baselineTotal).toFixed(1))
  const speedupRatio = totalSeconds > 0 ? Number((baselineTotal / totalSeconds).toFixed(2)) : 1.0

  return {
    runAt: params.runAt ?? new Date().toISOString(),
    repository: params.repository,
    totalSeconds: Number(totalSeconds.toFixed(1)),
    stages: params.stages.map((s) => ({ ...s })),
    comparisonWithBaseline: {
      baselineTotalSeconds: baselineTotal,
      deltaSeconds,
      speedupRatio,
    },
  }
}

/**
 * Generates an honest, human-readable markdown table reporting wall-clock per stage,
 * explicitly naming what was skipped, capped, or failed.
 */
export function formatBenchmarkReport(result: BenchmarkResult): string {
  const lines: string[] = [
    '# Forge Benchmark Comparison',
    '',
    `**Repository:** \`${result.repository}\``,
    `**Run Timestamp:** \`${result.runAt}\``,
    `**Baseline:** \`${COMMITTED_BENCHMARK_BASELINE.date} (${COMMITTED_BENCHMARK_BASELINE.runtimes}) on ${COMMITTED_BENCHMARK_BASELINE.target}\``,
    '',
    '| Stage | Duration | Status | Notes |',
    '| :--- | :--- | :--- | :--- |',
  ]

  for (const s of result.stages) {
    const statusBadge =
      s.status === 'completed'
        ? 'Completed'
        : s.status === 'skipped'
          ? '⏭️ Skipped'
          : s.status === 'capped'
            ? '⏱️ Capped'
            : '❌ Failed'
    const noteText = s.notes ?? '—'
    lines.push(`| ${s.name} | ${s.durationSeconds.toFixed(1)}s | ${statusBadge} | ${noteText} |`)
  }

  const deltaSign = result.comparisonWithBaseline.deltaSeconds <= 0 ? '' : '+'
  const speedupText =
    result.comparisonWithBaseline.speedupRatio >= 1
      ? `${String(result.comparisonWithBaseline.speedupRatio)}x faster`
      : `${(1 / result.comparisonWithBaseline.speedupRatio).toFixed(2)}x slower`

  lines.push('')
  lines.push(`- **Total Current Time:** ${result.totalSeconds.toFixed(1)}s`)
  lines.push(`- **Baseline Total:** ${String(result.comparisonWithBaseline.baselineTotalSeconds)}s`)
  lines.push(
    `- **Delta:** ${deltaSign}${String(result.comparisonWithBaseline.deltaSeconds)}s (${speedupText})`,
  )
  lines.push(
    `- **Manual Equivalent:** ~${String(COMMITTED_BENCHMARK_BASELINE.manualEquivalentSeconds[0])}-${String(COMMITTED_BENCHMARK_BASELINE.manualEquivalentSeconds[1])}s`,
  )

  return lines.join('\n')
}

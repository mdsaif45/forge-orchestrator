import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeBenchmarkResult,
  formatBenchmarkReport,
  parseTimelineJsonl,
} from '../src/main/benchmarks/benchmarkHarness.ts'

const logPath = process.env.TIMELINE_LOG ?? join('audit-out', 'timeline.jsonl')

if (!existsSync(logPath)) {
  console.log(`[BENCHMARK] No timeline file found at ${logPath}.`)
  console.log(
    `[BENCHMARK] Using sample run to demonstrate comparison table against committed baseline:\n`,
  )

  const sampleStages = [
    { name: 'Planning Stage', durationSeconds: 45.2, status: 'completed' },
    { name: 'Implementation Stage', durationSeconds: 18.5, status: 'completed' },
    {
      name: 'Code Audit Stage',
      durationSeconds: 0.0,
      status: 'skipped',
      notes: 'Unrequested stage skipped',
    },
  ]

  const result = computeBenchmarkResult({
    repository: 'foldervault (sample run)',
    stages: sampleStages,
  })

  console.log(formatBenchmarkReport(result))
  process.exit(0)
}

const content = readFileSync(logPath, 'utf8')
const stages = parseTimelineJsonl(content)
const result = computeBenchmarkResult({
  repository: process.env.FORGE_AUDIT_REPO ?? 'foldervault',
  stages,
})

console.log(formatBenchmarkReport(result))

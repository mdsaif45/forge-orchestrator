import { existsSync } from 'node:fs'
import { projectIdSchema } from '@shared/domain'
import type { ProjectStore } from './projectStore'
import type { RunStore } from './runStore'

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly repositoryPath: string
  readonly defaultBranch: string
  readonly existsOnDisk: boolean
  readonly totalRuns: number
  readonly activeRuns: number
  readonly lastRunTimestamp: string | null
  readonly lastRunStatus: string | null
}

export interface ProjectRegistryReport {
  readonly valid: boolean
  readonly totalProjects: number
  readonly activeProjects: number
  readonly missingProjects: number
  readonly projects: readonly ProjectSummary[]
  readonly formattedSummary: string
}

export interface ProjectPruneResult {
  readonly valid: boolean
  readonly prunedCount: number
  readonly prunedProjectIds: readonly string[]
  readonly formattedSummary: string
}

/**
 * Inspects all registered projects, cross-referencing disk existence and run activity (Axioms A1, A4).
 */
export async function inspectProjectRegistry(
  projectStore: ProjectStore,
  runStore: RunStore,
): Promise<ProjectRegistryReport> {
  await Promise.resolve()
  const projects = projectStore.list()
  const summaries: ProjectSummary[] = []

  let activeCount = 0
  let missingCount = 0

  for (const p of projects) {
    const exists = existsSync(p.repository.absolutePath)
    if (exists) {
      activeCount++
    } else {
      missingCount++
    }

    const runs = runStore.listRuns({ projectId: p.id, limit: 100 })
    const totalRuns = runs.length
    const activeRuns = runs.filter((r) => r.status === 'running').length
    const latestRun = runs[0]

    summaries.push({
      id: p.id,
      name: p.name,
      repositoryPath: p.repository.absolutePath,
      defaultBranch: p.repository.defaultBranch,
      existsOnDisk: exists,
      totalRuns,
      activeRuns,
      lastRunTimestamp: latestRun ? (latestRun.finishedAt ?? latestRun.startedAt) : null,
      lastRunStatus: latestRun ? latestRun.status : null,
    })
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name))

  const lines = [
    `FORGE PROJECT REGISTRY (${String(summaries.length)} total, ${String(activeCount)} active, ${String(missingCount)} missing on disk):`,
  ]

  if (summaries.length === 0) {
    lines.push('  No registered projects found.')
  } else {
    for (const s of summaries) {
      const statusBadge = s.existsOnDisk ? 'ONLINE' : 'MISSING'
      const runInfo =
        s.totalRuns > 0
          ? `${String(s.totalRuns)} run(s) (last: ${s.lastRunStatus ?? 'none'})`
          : '0 runs'
      lines.push(`  • [${statusBadge}] ${s.name} (${s.id})`)
      lines.push(`    Path:    ${s.repositoryPath}`)
      lines.push(`    Branch:  ${s.defaultBranch} | Runs: ${runInfo}`)
    }
  }

  return {
    valid: true,
    totalProjects: summaries.length,
    activeProjects: activeCount,
    missingProjects: missingCount,
    projects: summaries,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Removes registered projects whose repository path no longer exists on disk (Axiom A1).
 */
export async function pruneMissingProjects(
  projectStore: ProjectStore,
  runStore: RunStore,
): Promise<ProjectPruneResult> {
  const report = await inspectProjectRegistry(projectStore, runStore)
  const prunedIds: string[] = []

  for (const p of report.projects) {
    if (!p.existsOnDisk) {
      projectStore.delete(projectIdSchema.parse(p.id))
      prunedIds.push(p.id)
    }
  }

  return {
    valid: true,
    prunedCount: prunedIds.length,
    prunedProjectIds: prunedIds,
    formattedSummary:
      prunedIds.length > 0
        ? `✓ Pruned ${String(prunedIds.length)} missing project(s) from registry:\n` +
          prunedIds.map((id) => `  • ${id}`).join('\n')
        : '✓ No missing projects found to prune.',
  }
}

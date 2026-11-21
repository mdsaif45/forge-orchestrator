import { runIdSchema, type ArtifactMetadata, type RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export type CommitType = 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore'

export interface SynthesizeCommitOptions {
  readonly task?: string | undefined
  readonly runId?: string | undefined
  readonly scopeOverride?: string | undefined
}

export interface SynthesizedCommitReport {
  readonly valid: boolean
  readonly type: CommitType
  readonly scope?: string | undefined
  readonly subject: string
  readonly header: string
  readonly body: string
  readonly fullCommitMessage: string
  readonly breaking: boolean
  readonly breakingReason?: string | undefined
  readonly filesChanged: readonly string[]
  readonly totalAdditions: number
  readonly totalDeletions: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Synthesizes structured conventional semantic commit messages from physical git diffs.
 *
 * Implements Axiom A3 (Physical evidence beats claims):
 * Generates conventional commits based strictly on actual diffed files, hunks, and physical modifications.
 */
export function synthesizeChangesetCommit(
  diffText: string,
  options: SynthesizeCommitOptions = {},
): SynthesizedCommitReport {
  if (!diffText.trim()) {
    return {
      valid: false,
      type: 'chore',
      subject: options.task ?? 'empty changeset',
      header: `chore: ${options.task ?? 'empty changeset'}`,
      body: 'No files modified in changeset.',
      fullCommitMessage: `chore: ${options.task ?? 'empty changeset'}\n\nNo files modified in changeset.`,
      breaking: false,
      filesChanged: [],
      totalAdditions: 0,
      totalDeletions: 0,
      formattedSummary: 'Empty changeset diff; cannot synthesize commit message.',
      error: 'Empty changeset diff',
    }
  }

  const lines = diffText.split(/\r?\n/)
  const filesChanged: string[] = []
  let totalAdditions = 0
  let totalDeletions = 0
  let hasBreakingMarker = false
  let breakingReason: string | undefined

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ')
      const bPath = parts[3] ?? parts[2] ?? ''
      const cleaned = bPath.replace(/^[a-b]\//, '')
      if (cleaned && !filesChanged.includes(cleaned)) {
        filesChanged.push(cleaned)
      }
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      totalAdditions++
      if (/BREAKING[\s-_]?CHANGE[:\s]/i.test(line)) {
        hasBreakingMarker = true
        breakingReason = line.slice(1).trim()
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      totalDeletions++
    }
  }

  // 1. Determine Type
  let type: CommitType = 'feat'
  const taskLower = (options.task ?? '').toLowerCase()

  if (taskLower.startsWith('fix') || taskLower.includes('bug') || taskLower.includes('repair')) {
    type = 'fix'
  } else if (taskLower.startsWith('test') || filesChanged.every((f) => f.includes('test'))) {
    type = 'test'
  } else if (
    taskLower.startsWith('docs') ||
    filesChanged.every((f) => f.endsWith('.md') || f.startsWith('docs/'))
  ) {
    type = 'docs'
  } else if (taskLower.startsWith('refactor') || taskLower.includes('cleanup')) {
    type = 'refactor'
  } else if (
    filesChanged.length > 0 &&
    filesChanged.every((f) => f.startsWith('.') || f.endsWith('.json'))
  ) {
    type = 'chore'
  }

  // 2. Determine Scope
  let scope = options.scopeOverride
  if (!scope && filesChanged.length > 0) {
    const scopes = new Set<string>()
    for (const f of filesChanged) {
      const segments = f.split('/')
      if (segments.length > 2 && segments[0] === 'src' && segments[1] === 'main') {
        scopes.add(segments[2] ?? '')
      } else if (segments.length > 1) {
        scopes.add(segments[0] ?? '')
      }
    }
    const cleanScopes = Array.from(scopes).filter(Boolean)
    if (cleanScopes.length === 1) {
      scope = cleanScopes[0]
    } else if (cleanScopes.length > 1) {
      scope = cleanScopes.slice(0, 2).join(',')
    }
  }

  // 3. Subject
  let subject = options.task?.trim() ?? ''
  if (!subject) {
    subject = `update ${String(filesChanged.length)} file(s)`
  }
  // Strip leading "feat:", "fix:", etc. if user task already included it
  subject = subject.replace(/^(feat|fix|refactor|test|docs|chore)(\([^)]+\))?:\s*/i, '')

  const scopePrefix = scope ? `(${scope})` : ''
  const breakingMarker = hasBreakingMarker ? '!' : ''
  const header = `${type}${scopePrefix}${breakingMarker}: ${subject}`

  // 4. Body
  const bodyLines: string[] = []
  bodyLines.push(`Physical git diff summary:`)
  bodyLines.push(
    `• ${String(filesChanged.length)} file(s) changed (+${String(totalAdditions)}, -${String(totalDeletions)})`,
  )
  for (const f of filesChanged) {
    bodyLines.push(`  - ${f}`)
  }

  if (hasBreakingMarker) {
    bodyLines.push('\nBREAKING CHANGE:')
    bodyLines.push(breakingReason ?? 'Breaking change detected in diff additions.')
  }

  const body = bodyLines.join('\n')
  const fullCommitMessage = `${header}\n\n${body}`

  const formattedSummary = `Commit Header: ${header}\nFiles: ${String(filesChanged.length)} (+${String(totalAdditions)} / -${String(totalDeletions)})\n\n${body}`

  return {
    valid: true,
    type,
    scope,
    subject,
    header,
    body,
    fullCommitMessage,
    breaking: hasBreakingMarker,
    breakingReason,
    filesChanged,
    totalAdditions,
    totalDeletions,
    formattedSummary,
  }
}

/**
 * Authoritatively synthesizes a conventional commit from recorded run changeset diff artifacts.
 */
export async function synthesizeRunChangesetCommit(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  rawRunId: string,
  options: SynthesizeCommitOptions = {},
): Promise<SynthesizedCommitReport> {
  const parsedRunId = runIdSchema.safeParse(rawRunId)
  if (!parsedRunId.success) {
    return {
      valid: false,
      type: 'chore',
      subject: 'invalid run',
      header: 'chore: invalid run',
      body: `Invalid runId format: ${rawRunId}`,
      fullCommitMessage: `chore: invalid run\n\nInvalid runId format: ${rawRunId}`,
      breaking: false,
      filesChanged: [],
      totalAdditions: 0,
      totalDeletions: 0,
      formattedSummary: `Invalid runId: ${rawRunId}`,
      error: `Invalid runId format: ${rawRunId}`,
    }
  }

  const runId: RunId = parsedRunId.data
  const artifacts: readonly ArtifactMetadata[] = artifactStore.listForRun(runId)
  const diffArtifact = artifacts.find((a) => a.kind === 'changeset' || a.kind === 'diff')

  if (!diffArtifact) {
    return {
      valid: false,
      type: 'chore',
      subject: options.task ?? 'no diff',
      header: `chore: ${options.task ?? 'no diff'}`,
      body: `No changeset or diff artifacts recorded for run ${runId}.`,
      fullCommitMessage: `chore: ${options.task ?? 'no diff'}\n\nNo changeset or diff artifacts recorded for run ${runId}.`,
      breaking: false,
      filesChanged: [],
      totalAdditions: 0,
      totalDeletions: 0,
      formattedSummary: `No changeset or diff artifacts recorded for run ${runId}.`,
      error: `No changeset or diff artifacts found for run ${runId}`,
    }
  }

  const rawDiff = await artifactService.readArtifactText(diffArtifact.id)
  return synthesizeChangesetCommit(rawDiff, { ...options, runId })
}

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectNoProgress,
  fingerprintChange,
  promptPacketSchema,
  transition,
  workflowLimitsSchema,
  type PromptPacket,
  type WorkflowState,
} from '@shared/domain'
import { GitService } from '../git'
import { MockAgentRuntime } from './mockRuntime'
import { SCENARIOS } from './scenario'

/**
 * The loop guards, against a real runtime and a real repository.
 *
 * The unit tests in `shared/domain/guards.test.ts` cover the decisions. These cover the
 * claim the issue actually makes — that an agent which never makes progress is stopped —
 * by running a scripted agent against a git worktree and fingerprinting the diffs it
 * really produces. A test that fed hand-written fingerprints to the detector would prove
 * the detector works on hand-written fingerprints.
 */

let repoPath: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

function packet(): PromptPacket {
  return promptPacketSchema.parse({
    role: 'implementer',
    objective: 'Correct the constant',
    constraints: [],
    rules: [],
    lockedDecisions: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    relevantFiles: [],
    reviewFindings: ['The value is still wrong'],
    previousAttempt: null,
    completionCriteria: [],
    answeredQuestions: [],
  })
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-guards-'))
  git('init', '--quiet', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@forge.local')
  git('config', 'user.name', 'Forge Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repoPath, 'src'))
  writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 40\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

describe('a review that always fails', () => {
  it('halts at the iteration cap rather than looping forever', async () => {
    // The first half of the definition of done. The scenario resubmits work every round and
    // the review never passes; the run must end at the cap, not continue indefinitely.
    const limits = workflowLimitsSchema.parse({ maxIterations: 3 })
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.noProgress })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

    let state: WorkflowState = 'IMPLEMENTING'
    let iteration = 0
    let rounds = 0

    try {
      // Bounded far above the cap: if the guard did not work, this would be the thing that
      // stopped the test, and the assertions below would fail rather than hang.
      while (rounds < 20 && state !== 'HALTED_LIMIT') {
        rounds += 1

        await runtime.send(session, packet())

        state = transition(state, 'implemented', { iteration }).to
        state = transition(state, 'verified', { iteration }).to
        state = transition(state, 'reviewFailed', { iteration }).to

        const result = transition(state, 'correctionStarted', {
          iteration,
          maxIterations: limits.maxIterations,
        })
        state = result.to
        iteration = result.iteration
      }
    } finally {
      await runtime.dispose(session)
    }

    expect(state).toBe('HALTED_LIMIT')
    // Stopped at the cap, not at the loop bound.
    expect(rounds).toBe(limits.maxIterations + 1)
    expect(iteration).toBe(limits.maxIterations)
  })
})

describe('the no-progress detector', () => {
  it('fires on a runtime that keeps resubmitting the same change', async () => {
    // The second half of the definition of done, and the reason the detector fingerprints
    // the *diff* rather than the report: this scenario varies its summary wording every
    // round while writing byte-identical content.
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.noProgress })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    const service = new GitService({ repositoryPath: repoPath })

    const fingerprints: string[] = []
    let haltCode: string | null = null

    try {
      for (let round = 0; round < 8 && haltCode === null; round += 1) {
        await runtime.send(session, packet())

        // The real diff the agent produced, not what it said it produced.
        const diff = await service.diffWorktree('HEAD')
        fingerprints.push(fingerprintChange(diff.files, diff.patch))

        const decision = detectNoProgress(fingerprints)
        if (decision !== null) haltCode = decision.code
      }
    } finally {
      await runtime.dispose(session)
    }

    expect(haltCode).toBe('no-progress')
    // Caught on the second identical diff, well before the default cap of five would have
    // been reached — which is the whole value over relying on the cap alone.
    expect(fingerprints).toHaveLength(2)
    expect(fingerprints[0]).toBe(fingerprints[1])

    // The scenario's own report claims a change every round, so the summary was not what
    // gave it away -- the diff was.
    expect(SCENARIOS.noProgress.steps[0]?.report?.filesChanged).toEqual(['src/math.ts'])
  })

  it('does not fire on a runtime that genuinely changes something each round', async () => {
    // The correction scenario writes 41 and then 42, so consecutive diffs differ. A
    // detector that fired here would halt every legitimate correction loop.
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.correction })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    const service = new GitService({ repositoryPath: repoPath })

    const fingerprints: string[] = []

    try {
      for (let round = 0; round < 2; round += 1) {
        await runtime.send(session, packet())
        const diff = await service.diffWorktree('HEAD')
        fingerprints.push(fingerprintChange(diff.files, diff.patch))
      }
    } finally {
      await runtime.dispose(session)
    }

    expect(fingerprints[0]).not.toBe(fingerprints[1])
    expect(detectNoProgress(fingerprints)).toBeNull()
  })

  it('catches the liar, whose diff is empty every round', async () => {
    // A different shape of the same problem: an agent claiming files changed while the
    // worktree stays clean produces an identical (empty) fingerprint each round.
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.liar })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    const service = new GitService({ repositoryPath: repoPath })

    try {
      await runtime.send(session, packet())
      const diff = await service.diffWorktree('HEAD')

      // Nothing changed, though the report claims src/math.ts did.
      expect(diff.files).toEqual([])

      const empty = fingerprintChange(diff.files, diff.patch)
      expect(detectNoProgress([empty, empty])?.code).toBe('no-progress')
    } finally {
      await runtime.dispose(session)
    }
  })
})

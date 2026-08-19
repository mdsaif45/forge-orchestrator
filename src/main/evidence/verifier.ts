import {
  evidenceFindings,
  evidencePassed,
  summariseEvidence,
  type AgentReport,
  type EvidenceArtifact,
  type Repository,
  type StepId,
  type WorkflowId,
} from '@shared/domain'
import { runCommand, type RunCommandInput } from './commandRunner'

/**
 * The `system` verification step: Forge runs the project's own build and tests and
 * reports what it observed.
 *
 * This is the concrete replacement for the orchestrator's injected `verify` stub.
 * The stub returned a caller-supplied boolean; this returns a verdict computed from
 * commands Forge ran itself, with the artifacts kept so the claim can be compared
 * against the fact afterwards.
 */

export interface VerifyInput {
  readonly repository: Repository
  readonly workflowId: WorkflowId
  readonly stepId: StepId
  /**
   * What the agent said it did. Used only to detect a claim the evidence
   * contradicts — never to decide the verdict.
   */
  readonly report: AgentReport | null
  readonly timeoutMs?: number | undefined
  readonly now?: (() => number) | undefined
  readonly signal?: AbortSignal | undefined
  /** Injected in tests so no real process is spawned. */
  readonly run?: ((input: RunCommandInput) => Promise<EvidenceArtifact>) | undefined
}

export interface VerifyResult {
  readonly passed: boolean
  /** One line, suitable for a step log or a transition reason. */
  readonly detail: string
  /** Everything Forge ran, in order. Persisted by the caller. */
  readonly artifacts: readonly EvidenceArtifact[]
  /** Phrased for the agent that has to fix them. Empty when everything passed. */
  readonly findings: readonly string[]
  /**
   * Claims the evidence contradicts.
   *
   * Separate from `findings` because a false claim is a different problem from a
   * failing build: the build failing is ordinary, an agent reporting tests it never
   * ran is a trust failure worth surfacing on its own.
   */
  readonly falseClaims: readonly string[]
}

/**
 * Runs the configured build and test commands and computes a verdict.
 *
 * Ordering is build-then-test, and a failed build skips the tests: a test run
 * against a tree that does not compile produces output about the build failure,
 * which is noise in an evidence artifact labelled `tests`.
 */
export async function verifyStep(input: VerifyInput): Promise<VerifyResult> {
  const run = input.run ?? runCommand
  const { repository } = input
  const artifacts: EvidenceArtifact[] = []

  // Built by conditional assignment rather than by spreading the input: under
  // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
  // absent key, and passing one through would not typecheck.
  const base: Omit<RunCommandInput, 'command' | 'kind'> = {
    cwd: repository.absolutePath,
    workflowId: input.workflowId,
    stepId: input.stepId,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }

  if (repository.buildCommand !== null) {
    artifacts.push(await run({ ...base, command: repository.buildCommand, kind: 'build' }))
  }

  const buildFailed = artifacts.some((artifact) => !evidencePassed(artifact))

  if (repository.testCommand !== null && !buildFailed) {
    artifacts.push(await run({ ...base, command: repository.testCommand, kind: 'tests' }))
  }

  const findings = artifacts.flatMap((artifact) => [...evidenceFindings(artifact)])
  const falseClaims = detectFalseClaims(input.report, repository, artifacts)

  return {
    // Unverifiable is not passing. With no commands configured there is no evidence,
    // and treating an absence of failure as success is exactly the inference A3
    // forbids — so this passes only when something was actually run and succeeded.
    passed: artifacts.length > 0 && artifacts.every((artifact) => evidencePassed(artifact)),
    detail: detailFor(artifacts, falseClaims),
    artifacts,
    findings: [...findings, ...falseClaims],
    falseClaims,
  }
}

/**
 * Claims in the agent's report that the evidence contradicts.
 *
 * The `liar` scenario reports `testsRun: true` while changing nothing and running
 * nothing. Reconciliation (#34) catches its file claims by diffing; this catches the
 * `testsRun` claim, which no diff can see — the two together are what make a report
 * checkable rather than merely plausible.
 */
function detectFalseClaims(
  report: AgentReport | null,
  repository: Repository,
  artifacts: readonly EvidenceArtifact[],
): readonly string[] {
  if (report === null) return []

  const claims: string[] = []
  const testEvidence = artifacts.find((artifact) => artifact.kind === 'tests')

  if (report.testsRun && testEvidence === undefined && repository.testCommand === null) {
    claims.push(
      'The report claims tests were run, but this project has no test command configured, so no test run could be verified. Do not report tests as run when Forge cannot confirm them.',
    )
  }

  if (report.testsRun && testEvidence !== undefined && !evidencePassed(testEvidence)) {
    claims.push(
      `The report claims tests were run and the work is complete, but Forge ran \`${testEvidence.command}\` and it did not pass (${summariseEvidence(testEvidence)}). Fix the failures rather than reporting success.`,
    )
  }

  return claims
}

/** One line naming what ran and how it ended, leading with the worst outcome. */
function detailFor(artifacts: readonly EvidenceArtifact[], falseClaims: readonly string[]): string {
  if (artifacts.length === 0) {
    return 'no build or test command is configured, so nothing could be verified'
  }

  const parts = artifacts.map((artifact) => summariseEvidence(artifact))
  const claimNote = falseClaims.length > 0 ? `; ${String(falseClaims.length)} false claim(s)` : ''

  return `${parts.join('; ')}${claimNote}`
}

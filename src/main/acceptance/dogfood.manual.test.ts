import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initialiseDatabase } from '../db'
import { ProjectService } from '../projects/projectService'
import { WorkflowService } from '../workflows/workflowService'
import { ProcessManager } from '../process/processManager'
import { ClaudeCliRuntime } from '../runtimes/claudeCliRuntime'
import { createPipeProcessRunner } from '../runtimes/pipeProcessRunner'
import { RuntimeRegistry } from '../runtimes/registry'

/**
 * Traces where a real workflow actually stops.
 *
 * The full dogfood run timed out with the repository untouched, which says the
 * workflow never reached a terminal state but not why. This writes every state
 * transition to a file as it happens, so a stall is visible rather than inferred —
 * vitest discards console output, and a run this long cannot be watched live.
 */
describe.skipIf(process.env.FORGE_DOGFOOD === undefined)('dogfood', () => {
  it(
    'runs a real multi-agent workflow against a real repository',
    { timeout: 600_000 },
    async () => {
      const trace = process.env.FORGE_DOGFOOD_REPORT ?? 'dogfood-trace.txt'
      const note = (line: string): void => {
        appendFileSync(trace, `${new Date().toISOString()} ${line}\n`, 'utf8')
      }

      const repositoryPath = process.env.FORGE_DOGFOOD ?? ''
      const { db } = initialiseDatabase(join(mkdtempSync(join(tmpdir(), 'fd-db-')), 'forge.db'))

      const processes = new ProcessManager()
      const registry = new RuntimeRegistry()
      registry.register(new ClaudeCliRuntime({ runner: createPipeProcessRunner() }))

      const projects = new ProjectService(db)
      const project = await projects.create({
        name: 'Dogfood',
        repositoryPath,
        defaultBranch: 'main',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        tech: ['node'],
        rules: [],
      })
      note(`project created: ${project.id}`)

      const workflows = new WorkflowService({
        db,
        projects,
        packetDir: join(mkdtempSync(join(tmpdir(), 'fd-packets-')), 'packets'),
        registry,
        emitEvent: (payload) => {
          note(`EVENT ${payload.type} state=${payload.state ?? '-'} ${payload.detail ?? ''}`)
        },
        emitLog: (payload) => {
          note(`LOG step=${String(payload.stepIndex)} ${payload.text.slice(0, 300)}`)
        },
      })

      const started = await workflows.start({
        projectId: project.id,
        objective: 'src/math.js add() subtracts but must sum. Fix it.',
        autoRun: true,
      })
      note(`workflow started: ${started.id} state=${started.state}`)

      // Samples the state rather than waiting for a condition, because the question is
      // *where* it stops, not whether it finishes.
      let last = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = workflows.get(started.id)
        const state = `${current?.state ?? 'gone'} steps=${String(current?.steps.length ?? 0)} finished=${String(current?.finishedAt !== null)}`
        if (state !== last) {
          note(`STATE ${state}`)
          last = state
        }
        if (current?.finishedAt !== null) break
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }

      const final = workflows.get(started.id)
      note(`FINAL ${final?.state ?? 'gone'} halt=${final?.haltReason ?? '-'}`)
      for (const step of final?.steps ?? []) {
        note(
          `  step ${String(step.index)} ${step.role} state=${step.state} verdict=${step.verdict ?? '-'} report=${step.reportStatus ?? '-'}`,
        )
      }

      await processes.killAll('dogfood done')

      // Asserted against the workflow reaching DONE, not against the process exiting.
      // The first version of this harness checked `expect(final).not.toBeNull()`, which
      // passed while the repository was untouched and nothing had happened — a test that
      // cannot fail when the product does nothing is not evidence (#130).
      expect(final?.state).toBe('DONE')
      expect(final?.steps.every((step) => step.verdict !== 'fail')).toBe(true)
    },
  )
})

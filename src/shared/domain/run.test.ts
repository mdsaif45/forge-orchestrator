import { describe, expect, it } from 'vitest'
import {
  projectIdSchema,
  runIdSchema,
  runRecordSchema,
  stepIdSchema,
  stepRecordSchema,
  taskIdSchema,
} from './index'

const UUID_1 = '550e8400-e29b-41d4-a716-446655440000'
const UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const UUID_3 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

describe('Run domain schema', () => {
  it('validates a valid RunRecord', () => {
    const validRun = {
      id: runIdSchema.parse(UUID_1),
      projectId: projectIdSchema.parse(UUID_2),
      taskId: taskIdSchema.parse(UUID_3),
      type: 'direct-task' as const,
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: { model: 'qwen2.5-coder:7b', provider: 'ollama' },
    }

    const parsed = runRecordSchema.parse(validRun)
    expect(parsed.id).toBe(validRun.id)
    expect(parsed.type).toBe('direct-task')
    expect(parsed.status).toBe('running')
  })

  it('rejects an invalid run status or invalid UUID', () => {
    expect(() =>
      runRecordSchema.parse({
        id: 'not-a-uuid',
        projectId: UUID_1,
        taskId: UUID_2,
        type: 'direct-task',
        status: 'unknown-status',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      }),
    ).toThrow()
  })
})

describe('Step domain schema', () => {
  it('validates a valid StepRecord', () => {
    const validStep = {
      id: stepIdSchema.parse(UUID_1),
      runId: runIdSchema.parse(UUID_2),
      index: 0,
      role: 'implementer',
      runtimeId: null,
      status: 'completed' as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: 'Implemented feature',
      changeSetId: null,
      evidenceId: null,
    }

    const parsed = stepRecordSchema.parse(validStep)
    expect(parsed.index).toBe(0)
    expect(parsed.role).toBe('implementer')
    expect(parsed.status).toBe('completed')
  })
})

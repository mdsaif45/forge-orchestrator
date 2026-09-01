import { describe, expect, it } from 'vitest'
import { claudeSessionId } from './claudeSession'

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('claudeSessionId', () => {
  it('produces a valid v5 UUID', () => {
    // The CLI validates the format; a hash rendered as plain hex is rejected.
    expect(claudeSessionId({ workflowId: 'wf-1', stepIndex: 0, iteration: 1 })).toMatch(UUID_V5)
  })

  it('is stable for the same step', () => {
    // The whole point: after a restart Forge has lost whatever the provider
    // reported, and must still be able to name the session it wants to resume.
    const first = claudeSessionId({ workflowId: 'wf-1', stepIndex: 2, iteration: 1 })
    const second = claudeSessionId({ workflowId: 'wf-1', stepIndex: 2, iteration: 1 })
    expect(first).toBe(second)
  })

  it('differs per step', () => {
    const a = claudeSessionId({ workflowId: 'wf-1', stepIndex: 0, iteration: 1 })
    const b = claudeSessionId({ workflowId: 'wf-1', stepIndex: 1, iteration: 1 })
    expect(a).not.toBe(b)
  })

  it('differs per workflow', () => {
    const a = claudeSessionId({ workflowId: 'wf-1', stepIndex: 0, iteration: 1 })
    const b = claudeSessionId({ workflowId: 'wf-2', stepIndex: 0, iteration: 1 })
    expect(a).not.toBe(b)
  })

  it('differs per iteration, so a retry is a fresh conversation', () => {
    // A correction retry must not resume the transcript that produced the
    // rejected report: the agent would be asked to fix its mistake while still
    // reading that mistake as established context.
    const first = claudeSessionId({ workflowId: 'wf-1', stepIndex: 0, iteration: 1 })
    const retry = claudeSessionId({ workflowId: 'wf-1', stepIndex: 0, iteration: 2 })
    expect(first).not.toBe(retry)
  })

  it('does not confuse a step index with an iteration', () => {
    // Naive concatenation would make (step 1, iteration 2) and (step 12, ...)
    // collide, silently resuming the wrong conversation.
    const a = claudeSessionId({ workflowId: 'wf', stepIndex: 1, iteration: 2 })
    const b = claudeSessionId({ workflowId: 'wf', stepIndex: 12, iteration: 0 })
    expect(a).not.toBe(b)
  })
})

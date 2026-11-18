import { describe, expect, it } from 'vitest'
import { checkAntigravityPreflightRefusal } from './antigravityPreflight'

describe('antigravityPreflight', () => {
  it('detects profile picture eligibility check refusal from output text', () => {
    const output = 'Eligibility check failed: failed to get profile picture'
    const res = checkAntigravityPreflightRefusal(output)
    expect(res.refused).toBe(true)
    expect(res.reason).toContain('Pre-flight eligibility check failed')
  })

  it('detects eligibility failure from stderr', () => {
    const res = checkAntigravityPreflightRefusal('', 'Error: eligibility probe failed')
    expect(res.refused).toBe(true)
  })

  it('detects zero-turn error result in structured json', () => {
    const json = JSON.stringify({
      event: 'result',
      result: {
        status: 'ERROR',
        num_turns: 0,
        response: 'Network timeout during preflight',
      },
    })
    const res = checkAntigravityPreflightRefusal(json)
    expect(res.refused).toBe(true)
  })

  it('does not flag normal success turns', () => {
    const json = JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        num_turns: 1,
        response: 'Here is the plan',
      },
    })
    const res = checkAntigravityPreflightRefusal(json)
    expect(res.refused).toBe(false)
  })

  it('does not flag errors that occurred after turns were run', () => {
    const json = JSON.stringify({
      event: 'result',
      result: {
        status: 'ERROR',
        num_turns: 2,
        response: 'Model execution failed mid-run',
      },
    })
    const res = checkAntigravityPreflightRefusal(json)
    expect(res.refused).toBe(false)
  })
})

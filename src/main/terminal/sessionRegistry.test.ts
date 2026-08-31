import { describe, expect, it, vi } from 'vitest'
import type { ProcessHandle, ProcessOutcome } from '../process/processManager'
import { AgentSessionRegistry, agentSessionKey } from './sessionRegistry'

/** A handle whose completion the test controls, so exit is deterministic. */
const makeHandle = (
  runId: string,
): { handle: ProcessHandle; finish: (outcome?: Partial<ProcessOutcome>) => void } => {
  let resolve: (outcome: ProcessOutcome) => void = () => undefined
  const completed = new Promise<ProcessOutcome>((r) => {
    resolve = r
  })

  const handle: ProcessHandle = {
    runId,
    onData: () => () => undefined,
    completed,
    write: () => undefined,
    cancel: () => Promise.resolve(),
  }

  return {
    handle,
    finish: (outcome) => {
      resolve({
        runId,
        exitCode: 0,
        signal: null,
        output: '',
        durationMs: 0,
        ...outcome,
      } as ProcessOutcome)
    },
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgentSessionRegistry', () => {
  it('hands back the handle published for a step', () => {
    const registry = new AgentSessionRegistry()
    const { handle } = makeHandle('run-1')

    registry.publish(agentSessionKey('wf-1', 0), handle)

    expect(registry.lookup(agentSessionKey('wf-1', 0))).toBe(handle)
  })

  it('reports no handle for a step that is not running', () => {
    // The pane must be told there is nothing live rather than shown a stale
    // process; a blank pane is honest, a frozen one is not.
    expect(new AgentSessionRegistry().lookup(agentSessionKey('wf-1', 3))).toBeNull()
  })

  it('replaces the handle when a step re-runs', () => {
    // A correction retry reuses the step index with a new process. Keeping the
    // first would attach the pane to a dead process while the retry ran unseen.
    const registry = new AgentSessionRegistry()
    const key = agentSessionKey('wf-1', 2)
    const first = makeHandle('run-1')
    const second = makeHandle('run-2')

    registry.publish(key, first.handle)
    registry.publish(key, second.handle)

    expect(registry.lookup(key)).toBe(second.handle)
  })

  it('unpublishes a handle once its process exits', async () => {
    const registry = new AgentSessionRegistry()
    const key = agentSessionKey('wf-1', 0)
    const { handle, finish } = makeHandle('run-1')

    registry.publish(key, handle)
    finish()
    await flush()

    expect(registry.lookup(key)).toBeNull()
  })

  it('does not let an old process unpublish the one that replaced it', async () => {
    // The retry case again, in the direction that silently breaks: the first
    // process exits *after* the second is published, and a naive delete would
    // remove the live handle.
    const registry = new AgentSessionRegistry()
    const key = agentSessionKey('wf-1', 1)
    const first = makeHandle('run-1')
    const second = makeHandle('run-2')

    registry.publish(key, first.handle)
    registry.publish(key, second.handle)
    first.finish()
    await flush()

    expect(registry.lookup(key)).toBe(second.handle)
  })

  it('notifies a listener waiting for a step that has not started yet', () => {
    // The pane opens before the first agent spawns; without this it attaches to
    // nothing and stays blank for the whole run.
    const registry = new AgentSessionRegistry()
    const seen = vi.fn()
    registry.onPublished(seen)

    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1').handle)

    expect(seen).toHaveBeenCalledWith(agentSessionKey('wf-1', 0))
  })

  it('stops notifying after unsubscribe', () => {
    const registry = new AgentSessionRegistry()
    const seen = vi.fn()
    const unsubscribe = registry.onPublished(seen)

    unsubscribe()
    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1').handle)

    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps steps of different workflows apart', () => {
    const registry = new AgentSessionRegistry()
    const a = makeHandle('run-a')
    const b = makeHandle('run-b')

    registry.publish(agentSessionKey('wf-1', 0), a.handle)
    registry.publish(agentSessionKey('wf-2', 0), b.handle)

    expect(registry.lookup(agentSessionKey('wf-1', 0))).toBe(a.handle)
    expect(registry.lookup(agentSessionKey('wf-2', 0))).toBe(b.handle)
  })

  it('lists what is live', () => {
    const registry = new AgentSessionRegistry()
    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1').handle)
    registry.publish(agentSessionKey('wf-1', 1), makeHandle('run-2').handle)

    expect([...registry.liveKeys()].sort()).toEqual(['wf-1#0', 'wf-1#1'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { AgentSessionRegistry, agentSessionKey, type AttachableProcess } from './sessionRegistry'

/** A distinct process object per id, so identity comparisons are meaningful. */
const makeHandle = (id: string): AttachableProcess => ({
  write: () => {
    void id
  },
})

describe('AgentSessionRegistry', () => {
  it('hands back the handle published for a step', () => {
    const registry = new AgentSessionRegistry()
    const handle = makeHandle('run-1')

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

    registry.publish(key, first)
    registry.publish(key, second)

    expect(registry.lookup(key)).toBe(second)
  })

  it('unpublishes a handle once its process is retired', () => {
    const registry = new AgentSessionRegistry()
    const key = agentSessionKey('wf-1', 0)
    const handle = makeHandle('run-1')

    registry.publish(key, handle)
    registry.retire(key, handle)

    expect(registry.lookup(key)).toBeNull()
  })

  it('does not let an old process retire the one that replaced it', () => {
    // The retry case in the direction that silently breaks: the first process
    // exits *after* the second is published, and an unguarded delete would remove
    // the live handle and blank a pane showing a running step.
    const registry = new AgentSessionRegistry()
    const key = agentSessionKey('wf-1', 1)
    const first = makeHandle('run-1')
    const second = makeHandle('run-2')

    registry.publish(key, first)
    registry.publish(key, second)
    registry.retire(key, first)

    expect(registry.lookup(key)).toBe(second)
  })

  it('notifies a listener waiting for a step that has not started yet', () => {
    // The pane opens before the first agent spawns; without this it attaches to
    // nothing and stays blank for the whole run.
    const registry = new AgentSessionRegistry()
    const seen = vi.fn()
    registry.onPublished(seen)

    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1'))

    expect(seen).toHaveBeenCalledWith(agentSessionKey('wf-1', 0))
  })

  it('stops notifying after unsubscribe', () => {
    const registry = new AgentSessionRegistry()
    const seen = vi.fn()
    const unsubscribe = registry.onPublished(seen)

    unsubscribe()
    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1'))

    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps steps of different workflows apart', () => {
    const registry = new AgentSessionRegistry()
    const a = makeHandle('run-a')
    const b = makeHandle('run-b')

    registry.publish(agentSessionKey('wf-1', 0), a)
    registry.publish(agentSessionKey('wf-2', 0), b)

    expect(registry.lookup(agentSessionKey('wf-1', 0))).toBe(a)
    expect(registry.lookup(agentSessionKey('wf-2', 0))).toBe(b)
  })

  it('lists what is live', () => {
    const registry = new AgentSessionRegistry()
    registry.publish(agentSessionKey('wf-1', 0), makeHandle('run-1'))
    registry.publish(agentSessionKey('wf-1', 1), makeHandle('run-2'))

    expect([...registry.liveKeys()].sort()).toEqual(['wf-1#0', 'wf-1#1'])
  })
})

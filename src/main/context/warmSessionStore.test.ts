import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WarmSessionStore } from './warmSessionStore'

describe('WarmSessionStore (Issue #157)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `forge-warm-session-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore temporary file lock
    }
  })

  it('saves and finds warm session IDs for a role and runtime', () => {
    const store = new WarmSessionStore(tempDir)

    expect(store.find('wf-1', 'implementer', 'claude-cli')).toBeNull()

    store.save({
      workflowId: 'wf-1',
      role: 'implementer',
      runtimeId: 'claude-cli',
      providerSessionId: 'claude-sess-999',
      stepIndex: 1,
      updatedAt: new Date().toISOString(),
    })

    expect(store.find('wf-1', 'implementer', 'claude-cli')).toBe('claude-sess-999')
    expect(store.find('wf-1', 'reviewer', 'claude-cli')).toBeNull()
    expect(store.find('wf-2', 'implementer', 'claude-cli')).toBeNull()
  })

  it('persists across new store instances on disk', () => {
    const store1 = new WarmSessionStore(tempDir)
    store1.save({
      workflowId: 'wf-persistent',
      role: 'implementer',
      runtimeId: 'antigravity-cli',
      providerSessionId: 'agy-conv-777',
      stepIndex: 2,
      updatedAt: new Date().toISOString(),
    })

    const store2 = new WarmSessionStore(tempDir)
    expect(store2.find('wf-persistent', 'implementer', 'antigravity-cli')).toBe('agy-conv-777')
  })

  it('invalidates a rejected/stale session', () => {
    const store = new WarmSessionStore(tempDir)
    store.save({
      workflowId: 'wf-invalidate',
      role: 'implementer',
      runtimeId: 'claude-cli',
      providerSessionId: 'stale-id-123',
      stepIndex: 0,
      updatedAt: new Date().toISOString(),
    })

    expect(store.find('wf-invalidate', 'implementer', 'claude-cli')).toBe('stale-id-123')

    store.invalidate('wf-invalidate', 'implementer', 'claude-cli')
    expect(store.find('wf-invalidate', 'implementer', 'claude-cli')).toBeNull()
  })

  it('handles corrupted JSON files gracefully without throwing', () => {
    writeFileSync(join(tempDir, 'warm-sessions.json'), 'not valid json {{{', 'utf8')

    const store = new WarmSessionStore(tempDir)
    expect(store.find('wf-any', 'role', 'rt')).toBeNull()

    store.save({
      workflowId: 'wf-recovered',
      role: 'planner',
      runtimeId: 'mock:default',
      providerSessionId: 'mock-sess-1',
      stepIndex: 0,
      updatedAt: new Date().toISOString(),
    })

    expect(store.find('wf-recovered', 'planner', 'mock:default')).toBe('mock-sess-1')
  })

  it('clears all sessions for a workflow', () => {
    const store = new WarmSessionStore(tempDir)
    store.save({
      workflowId: 'wf-multi',
      role: 'implementer',
      runtimeId: 'claude-cli',
      providerSessionId: 'id-1',
      stepIndex: 0,
      updatedAt: new Date().toISOString(),
    })
    store.save({
      workflowId: 'wf-multi',
      role: 'reviewer',
      runtimeId: 'claude-cli',
      providerSessionId: 'id-2',
      stepIndex: 1,
      updatedAt: new Date().toISOString(),
    })
    store.save({
      workflowId: 'wf-other',
      role: 'implementer',
      runtimeId: 'claude-cli',
      providerSessionId: 'id-3',
      stepIndex: 0,
      updatedAt: new Date().toISOString(),
    })

    store.clearForWorkflow('wf-multi')

    expect(store.find('wf-multi', 'implementer', 'claude-cli')).toBeNull()
    expect(store.find('wf-multi', 'reviewer', 'claude-cli')).toBeNull()
    expect(store.find('wf-other', 'implementer', 'claude-cli')).toBe('id-3')
  })
})

/* eslint-disable @typescript-eslint/unbound-method */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRuntimeEventPayload } from '@shared/views'
import { useWorkflowRuntimeEvents } from './useWorkflowRuntimeEvents'

describe('useWorkflowRuntimeEvents (Issue #153)', () => {
  let eventListener: ((payload: WorkflowRuntimeEventPayload) => void) | null = null
  let unsubSpy: () => void

  beforeEach(() => {
    unsubSpy = vi.fn()
    eventListener = null

    // Mock window.forge.onWorkflowRuntimeEvent
    vi.stubGlobal('forge', {
      onWorkflowRuntimeEvent: vi.fn((listener: (payload: WorkflowRuntimeEventPayload) => void) => {
        eventListener = listener
        return unsubSpy
      }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useWorkflowRuntimeEvents('wf-123'))

    expect(window.forge.onWorkflowRuntimeEvent).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubSpy).toHaveBeenCalledTimes(1)
  })

  it('batches high-frequency tool and chunk events via requestAnimationFrame', () => {
    let rafCallback: FrameRequestCallback | null = null
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb
      return 1
    })

    const { result } = renderHook(() => useWorkflowRuntimeEvents('wf-100'))

    expect(result.current.toolTimeline).toHaveLength(0)
    expect(result.current.latestChunk).toBeNull()

    // Emit 3 rapid events for wf-100
    act(() => {
      eventListener?.({
        workflowId: 'wf-100',
        graphRunId: 'gr-1',
        nodeId: 'node-implementer',
        stepIndex: 0,
        event: {
          type: 'tool',
          at: '2026-11-18T12:00:00.000Z',
          name: 'bash',
          detail: 'command: npm test',
        },
      })

      eventListener?.({
        workflowId: 'wf-100',
        graphRunId: 'gr-1',
        nodeId: 'node-implementer',
        stepIndex: 0,
        event: {
          type: 'chunk',
          at: '2026-11-18T12:00:01.000Z',
          text: 'Running test suite...',
        },
      })

      eventListener?.({
        workflowId: 'wf-100',
        graphRunId: 'gr-1',
        nodeId: 'node-implementer',
        stepIndex: 0,
        event: {
          type: 'state',
          at: '2026-11-18T12:00:02.000Z',
          state: 'working',
        },
      })
    })

    // requestAnimationFrame was scheduled once for the batch
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    // Flush the animation frame
    act(() => {
      if (rafCallback) {
        rafCallback(performance.now())
      }
    })

    expect(result.current.toolTimeline).toHaveLength(1)
    expect(result.current.toolTimeline[0]?.name).toBe('bash')
    expect(result.current.toolTimeline[0]?.target).toBe('npm test')
    expect(result.current.toolTimeline[0]?.isVerifiedEvidence).toBe(false)
    expect(result.current.latestChunk).toBe('Running test suite...')
    expect(result.current.isWorking).toBe(true)
  })

  it('filters out events for different workflow IDs', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)

    const { result } = renderHook(() => useWorkflowRuntimeEvents('wf-target'))

    act(() => {
      eventListener?.({
        workflowId: 'wf-other',
        graphRunId: null,
        nodeId: null,
        stepIndex: 0,
        event: {
          type: 'chunk',
          at: '2026-11-18T12:00:00.000Z',
          text: 'From other workflow',
        },
      })
    })

    // Since event was for wf-other, no RAF was scheduled
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
    expect(result.current.latestChunk).toBeNull()
  })

  it('clears timeline and events on clearEvents()', () => {
    let rafCallback: FrameRequestCallback | null = null
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb
      return 1
    })

    const { result } = renderHook(() => useWorkflowRuntimeEvents('wf-clear'))

    act(() => {
      eventListener?.({
        workflowId: 'wf-clear',
        graphRunId: null,
        nodeId: null,
        stepIndex: 0,
        event: {
          type: 'tool',
          at: '2026-11-18T12:00:00.000Z',
          name: 'read_file',
          detail: 'path: test.ts',
        },
      })
      if (rafCallback) rafCallback(performance.now())
    })

    expect(result.current.toolTimeline).toHaveLength(1)

    act(() => {
      result.current.clearEvents()
    })

    expect(result.current.toolTimeline).toHaveLength(0)
    expect(result.current.latestChunk).toBeNull()
    expect(result.current.isWorking).toBe(false)
  })
})

import { useEffect, useRef, useState } from 'react'
import type { ToolCallEntry, WorkflowRuntimeEventPayload } from '@shared/views'
import { reduceToolTimeline } from '@shared/domain'

export interface WorkflowRuntimeEventsState {
  /** Complete accumulated tool calls for the workflow run, updated in real time. */
  readonly toolTimeline: readonly ToolCallEntry[]
  /** Latest text chunk streamed from the running agent. */
  readonly latestChunk: string | null
  /** Whether the agent is currently actively working or starting. */
  readonly isWorking: boolean
  /** Resets local runtime event state. */
  readonly clearEvents: () => void
}

/**
 * Subscribes to live agent runtime events for an active workflow.
 *
 * Axiom A3 Compliance:
 * Uses pure reducer `reduceToolTimeline` which enforces `isVerifiedEvidence: false`
 * on all tool entries.
 *
 * Performance:
 * Uses `requestAnimationFrame` batching so a burst of high-frequency NDJSON lines
 * (e.g. 500 events/second) flushes into React state once per frame rather than
 * causing 500 separate render passes.
 */
export function useWorkflowRuntimeEvents(workflowId: string | null): WorkflowRuntimeEventsState {
  const [toolTimeline, setToolTimeline] = useState<readonly ToolCallEntry[]>([])
  const [latestChunk, setLatestChunk] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState<boolean>(false)

  const timelineRef = useRef<readonly ToolCallEntry[]>([])
  const pendingEventsRef = useRef<WorkflowRuntimeEventPayload[]>([])
  const rafIdRef = useRef<number | null>(null)

  useEffect(() => {
    timelineRef.current = toolTimeline
  }, [toolTimeline])

  useEffect(() => {
    if (workflowId === null) {
      return
    }

    const flushQueue = () => {
      rafIdRef.current = null
      const queue = pendingEventsRef.current
      if (queue.length === 0) return
      pendingEventsRef.current = []

      let currentTimeline = timelineRef.current
      let newestChunk: string | null = null
      let newWorking: boolean | null = null

      for (const item of queue) {
        if (item.workflowId !== workflowId) continue

        const { event, stepIndex, nodeId } = item
        currentTimeline = reduceToolTimeline(currentTimeline, event, stepIndex, nodeId)

        if (event.type === 'chunk') {
          newestChunk = event.text
        } else if (event.type === 'state') {
          newWorking = event.state === 'working' || event.state === 'starting'
        } else if (event.type === 'result' || event.type === 'error') {
          newWorking = false
        }
      }

      timelineRef.current = currentTimeline
      setToolTimeline(currentTimeline)
      if (newestChunk !== null) {
        setLatestChunk(newestChunk)
      }
      if (newWorking !== null) {
        setIsWorking(newWorking)
      }
    }

    const unsubscribe = window.forge.onWorkflowRuntimeEvent((payload) => {
      if (payload.workflowId !== workflowId) return
      pendingEventsRef.current.push(payload)

      rafIdRef.current ??= requestAnimationFrame(flushQueue)
    })

    return () => {
      unsubscribe()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      pendingEventsRef.current = []
    }
  }, [workflowId])

  const clearEvents = () => {
    timelineRef.current = []
    setToolTimeline([])
    setLatestChunk(null)
    setIsWorking(false)
    pendingEventsRef.current = []
  }

  return {
    toolTimeline,
    latestChunk,
    isWorking,
    clearEvents,
  }
}

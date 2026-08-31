import type { ProcessHandle } from '../process/processManager'

/**
 * Where a running step's process is published so the UI can attach to it.
 *
 * The workflow pane used to spawn its own CLI session and render that, while the
 * agent doing the work ran unobserved (#154). Both processes were real; only one
 * of them was the run. Attaching requires a place where the step's own handle can
 * be found by id — this is that place, and nothing more.
 *
 * ```
 * orchestrator ──publish(stepKey, handle)──> registry <──lookup(stepKey)── terminal IPC
 *                                               │
 *                                        onData / write / resize
 * ```
 *
 * Deliberately not a singleton: a test needs its own registry, and a module-level
 * one would leak handles between tests — the same reasoning as `RuntimeRegistry`.
 *
 * It holds no process state of its own. `ProcessManager` owns lifetime; this owns
 * only the mapping, so a handle that dies is unpublished rather than reaped here.
 */
export class AgentSessionRegistry {
  private readonly handles = new Map<string, ProcessHandle>()
  private readonly listeners = new Set<(key: string) => void>()

  /**
   * Publishes the handle for a step, replacing any previous one.
   *
   * Replacing matters on a correction retry: the step index is the same, the
   * process is not. Keeping the first would attach the pane to a dead process and
   * show a frozen screen while the retry ran invisibly — the original defect, in
   * a narrower form.
   */
  publish(key: string, handle: ProcessHandle): void {
    this.handles.set(key, handle)
    for (const listener of this.listeners) listener(key)

    // Unpublished on exit rather than left to be garbage: a caller that attaches
    // after the step ends must be told there is nothing live, not handed a handle
    // whose process is gone.
    void handle.completed.then(() => {
      if (this.handles.get(key) === handle) this.handles.delete(key)
    })
  }

  /** The live handle for a step, or null when it is not running. */
  lookup(key: string): ProcessHandle | null {
    return this.handles.get(key) ?? null
  }

  /**
   * Notifies when a step's process becomes available.
   *
   * A user can open the pane before the step spawns — the workflow renders its
   * stages immediately, while the first agent takes seconds to start. Without
   * this the pane would attach to nothing and stay blank for the whole run.
   */
  onPublished(listener: (key: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every step currently running. Ordering is insertion order, not step order. */
  liveKeys(): readonly string[] {
    return [...this.handles.keys()]
  }
}

/**
 * The id a step's process is published under.
 *
 * Composed rather than using the step id alone because the pane resolves what to
 * show from the workflow and the step index it is rendering, and does not have a
 * step id until it has already loaded the step.
 */
export function agentSessionKey(workflowId: string, stepIndex: number): string {
  return `${workflowId}#${String(stepIndex)}`
}

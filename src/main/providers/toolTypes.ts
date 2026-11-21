/**
 * Type contracts for agent tools.
 * Separated from tools.ts to prevent circular dependencies with tools/*.ts (ADR-004).
 */

/** What a tool call reports back to the model. */
export interface ToolResult {
  /** False for a refusal or a real failure; the model is told which and why. */
  readonly ok: boolean
  readonly content: string
}

export interface ToolContext {
  /** The directory every relative path is resolved against and confined to. */
  readonly workspacePath: string
  /** Globs a write may touch. Empty means the task named no scope, so none. */
  readonly allowedPaths: readonly string[]
  readonly forbiddenPaths: readonly string[]
  /** Whether this role may write at all, decided by the caller from the binding. */
  readonly canWrite: boolean
  /** Runs a shell command; injected so a test never spawns one. */
  readonly runCommand?:
    | ((
        command: string,
        cwd: string,
      ) => Promise<{ readonly output: string; readonly code: number }>)
    | undefined
  /** Project ID for persistent rules. */
  readonly projectId?: string | undefined
  /** Callback to persist project rules in database. */
  readonly setRule?: ((scope: string, key: string, statement: string) => Promise<void>) | undefined
  /** Callback to retrieve project rules. */
  readonly getRules?:
    | (() => Promise<
        readonly { readonly scope: string; readonly key: string; readonly statement: string }[]
      >)
    | undefined
  /** Active file currently open in workspace editor. */
  readonly activeFilePath?: string | undefined
  /** Custom fetch implementation for testing. */
  readonly fetchImpl?: typeof fetch | undefined
}

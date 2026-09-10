import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../tools'

export const PLAN_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'enter_plan_mode',
      description:
        'Request permission to enter planning mode for complex tasks requiring exploration and architectural design before making changes.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description:
        'Exit planning mode and present the final implementation plan to the user for formal approval.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The structured implementation plan in Markdown format.',
          },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enter_worktree',
      description:
        'Create an isolated git worktree branch and switch the workspace session into it, preventing uncommitted edits from dirtying the primary repository.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Optional name for the worktree branch. Auto-generated if omitted.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exit_worktree',
      description:
        'Exit the current git worktree session and switch back to the primary project root.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['keep', 'remove'],
            description: '"keep" preserves the worktree; "remove" deletes the worktree folder.',
          },
          discard_changes: {
            type: 'boolean',
            description: 'Required true when action is "remove" and there are uncommitted changes.',
          },
        },
        required: ['action'],
      },
    },
  },
] as const

/** In-memory state tracking active plan mode and worktree session per workspace. */
const planModeState = new Set<string>()
const activeWorktrees = new Map<
  string,
  { worktreePath: string; branchName: string; originalPath: string }
>()

export function isPlanModeActive(workspacePath: string): boolean {
  return planModeState.has(workspacePath)
}

export function getActiveWorktree(workspacePath: string): string | undefined {
  return activeWorktrees.get(workspacePath)?.worktreePath
}

export function enterPlanModeTool(
  _args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  planModeState.add(context.workspacePath)
  return Promise.resolve({
    ok: true,
    content:
      'Entered plan mode. You are now in read-only exploration mode. Use research tools to inspect code and formulate your implementation plan. When finished, call exit_plan_mode with your proposal.',
  })
}

export async function exitPlanModeTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const plan = typeof args.plan === 'string' ? args.plan.trim() : ''
  if (plan === '') {
    return { ok: false, content: 'exit_plan_mode requires a "plan" markdown string.' }
  }

  planModeState.delete(context.workspacePath)
  const forgeDir = join(context.workspacePath, '.forge')
  await mkdir(forgeDir, { recursive: true }).catch(() => undefined)
  await writeFile(join(forgeDir, 'plan.md'), plan, 'utf8')

  return {
    ok: true,
    content: `Plan mode exited. Implementation plan recorded to .forge/plan.md. Awaiting user review and approval before execution.`,
  }
}

export async function enterWorktreeTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  const cleanName =
    rawName.replace(/[^a-zA-Z0-9_-]/g, '') || `agent-worktree-${Date.now().toString(36)}`

  const worktreePath = join(context.workspacePath, '.forge', 'worktrees', cleanName)
  const branchName = `forge/${cleanName}`

  if (context.runCommand) {
    const cmd = `git worktree add -b ${branchName} "${worktreePath}"`
    const res = await context.runCommand(cmd, context.workspacePath).catch((err: unknown) => ({
      output: err instanceof Error ? err.message : String(err),
      code: 1,
    }))

    if (res.code !== 0 && !res.output.includes('already exists')) {
      return {
        ok: false,
        content: `Failed to create git worktree: ${res.output}`,
      }
    }
  } else {
    await mkdir(worktreePath, { recursive: true }).catch(() => undefined)
  }

  const sessionData = {
    worktreePath,
    branchName,
    originalPath: context.workspacePath,
  }
  activeWorktrees.set(context.workspacePath, sessionData)
  activeWorktrees.set(worktreePath, sessionData)

  return {
    ok: true,
    content: JSON.stringify({
      worktreePath,
      worktreeBranch: branchName,
      message: `Created isolated worktree at "${worktreePath}" on branch "${branchName}". Subsequent changes will be sandboxed here.`,
    }),
  }
}

export async function exitWorktreeTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action : 'keep'
  const session =
    activeWorktrees.get(context.workspacePath) ??
    Array.from(activeWorktrees.values()).find(
      (s) => s.worktreePath === context.workspacePath || s.originalPath === context.workspacePath,
    )

  if (!session) {
    return {
      ok: true,
      content: 'No active git worktree session was recorded. Already in primary workspace.',
    }
  }

  if (action === 'remove' && context.runCommand) {
    const forceFlag = args.discard_changes === true ? ' --force' : ''
    const cmd = `git worktree remove "${session.worktreePath}"${forceFlag}`
    const res = await context.runCommand(cmd, session.originalPath).catch((err: unknown) => ({
      output: err instanceof Error ? err.message : String(err),
      code: 1,
    }))

    if (res.code !== 0) {
      return {
        ok: false,
        content: `Refused to remove worktree: ${res.output}. Pass discard_changes: true if you wish to force remove.`,
      }
    }
  }

  activeWorktrees.delete(session.originalPath)
  activeWorktrees.delete(session.worktreePath)

  return {
    ok: true,
    content: `Exited worktree session. Active context returned to primary workspace root "${session.originalPath}". Action taken: ${action}.`,
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../tools'

export const SCHEDULE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'schedule_cron',
      description:
        'Schedule a prompt to run recurringly on a cron schedule or at a specific future interval (create, delete, list).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'delete', 'list'],
            description:
              'Action to perform: create a schedule, delete by task_id, or list active schedules.',
          },
          cron_expression: {
            type: 'string',
            description:
              'Standard cron expression (e.g. "*/5 * * * *" for every 5 minutes). Required for create.',
          },
          prompt: {
            type: 'string',
            description: 'The instruction to trigger when the cron fires. Required for create.',
          },
          task_id: {
            type: 'string',
            description: 'Task ID to delete when action is "delete".',
          },
          durable: {
            type: 'boolean',
            description:
              'Whether to persist this scheduled task to .forge/scheduled_tasks.json across sessions.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep_delay',
      description:
        'Pause execution for a specified duration in seconds (bounded between 1 and 60 seconds).',
      parameters: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: 'Number of seconds to pause (min 1, max 60).',
          },
        },
        required: ['seconds'],
      },
    },
  },
] as const

interface ScheduledCronItem {
  readonly id: string
  readonly cronExpression: string
  readonly prompt: string
  readonly createdAt: string
  readonly durable: boolean
}

const inMemoryCronSchedules = new Map<string, ScheduledCronItem>()

export async function scheduleCronTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action : 'list'

  if (action === 'create') {
    const cron = typeof args.cron_expression === 'string' ? args.cron_expression.trim() : ''
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    const durable = args.durable === true

    if (cron === '' || prompt === '') {
      return {
        ok: false,
        content: 'schedule_cron "create" requires "cron_expression" and "prompt".',
      }
    }

    const id = `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const item: ScheduledCronItem = {
      id,
      cronExpression: cron,
      prompt,
      createdAt: new Date().toISOString(),
      durable,
    }

    inMemoryCronSchedules.set(id, item)

    if (durable) {
      const forgeDir = join(context.workspacePath, '.forge')
      await mkdir(forgeDir, { recursive: true }).catch(() => undefined)
      const tasksFile = join(forgeDir, 'scheduled_tasks.json')
      const existingRaw = await readFile(tasksFile, 'utf8').catch(() => '[]')
      try {
        const list = JSON.parse(existingRaw) as ScheduledCronItem[]
        list.push(item)
        await writeFile(tasksFile, JSON.stringify(list, null, 2), 'utf8')
      } catch {
        await writeFile(tasksFile, JSON.stringify([item], null, 2), 'utf8')
      }
    }

    return {
      ok: true,
      content: `Cron schedule created with ID "${id}" (${cron}). Triggering: "${prompt.slice(0, 50)}...". Durable: ${String(durable)}.`,
    }
  }

  if (action === 'delete') {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (taskId === '') {
      return { ok: false, content: 'schedule_cron "delete" requires "task_id".' }
    }

    inMemoryCronSchedules.delete(taskId)

    const forgeDir = join(context.workspacePath, '.forge')
    const tasksFile = join(forgeDir, 'scheduled_tasks.json')
    const existingRaw = await readFile(tasksFile, 'utf8').catch(() => null)
    if (existingRaw !== null) {
      try {
        const list = JSON.parse(existingRaw) as ScheduledCronItem[]
        const filtered = list.filter((item) => item.id !== taskId)
        await writeFile(tasksFile, JSON.stringify(filtered, null, 2), 'utf8')
      } catch {
        // Ignore JSON error
      }
    }

    return {
      ok: true,
      content: `Cron schedule "${taskId}" deleted.`,
    }
  }

  // list
  const list = Array.from(inMemoryCronSchedules.values())
  return {
    ok: true,
    content:
      list.length > 0
        ? JSON.stringify(list, null, 2)
        : 'No active in-memory cron schedules. Check .forge/scheduled_tasks.json for durable tasks.',
  }
}

export async function sleepDelayTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const rawSec = typeof args.seconds === 'number' ? args.seconds : 1
  const seconds = Math.min(Math.max(rawSec, 1), 60)

  await new Promise((res) => setTimeout(res, seconds * 1000))

  return {
    ok: true,
    content: `Paused for ${String(seconds)} second(s).`,
  }
}

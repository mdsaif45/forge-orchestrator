import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../tools'

interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

interface TaskItem {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly activeForm?: string | undefined
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  readonly metadata?: Record<string, unknown> | undefined
  readonly createdAt: string
  readonly updatedAt: string
}

export const TASK_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Update or initialize the task checklist for tracking multi-step progress across turns. Use this early in complex requests and update item statuses as work proceeds.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The updated list of todo items.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Unique ID for the todo item (auto-generated if omitted).',
                },
                content: { type: 'string', description: 'Description of the step or goal.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current execution status.',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_create',
      description: 'Create a tracked task item in the project task list.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Brief title for the task.' },
          description: {
            type: 'string',
            description: 'Detailed instructions of what needs to be done.',
          },
          activeForm: {
            type: 'string',
            description: 'Present continuous form shown in progress status (e.g. "Running tests").',
          },
          metadata: {
            type: 'object',
            description: 'Arbitrary key-value metadata to attach to the task.',
          },
        },
        required: ['subject', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_get',
      description: 'Retrieve details, status, and metadata of a tracked task by ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The unique ID of the task.' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_list',
      description: 'List all tracked tasks in the project, optionally filtering by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'all'],
            description: 'Filter tasks by status. Defaults to "all".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_update',
      description:
        'Update the status, subject, description, or metadata of an existing tracked task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The unique ID of the task to update.' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted'],
            description: 'New status for the task.',
          },
          subject: { type: 'string', description: 'Updated title for the task.' },
          description: { type: 'string', description: 'Updated instructions.' },
          metadata: { type: 'object', description: 'Updated metadata object.' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_output',
      description: 'Retrieve output or logs from a background task or subagent.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'ID of the task to inspect.' },
          block: { type: 'boolean', description: 'Whether to wait for task completion.' },
          timeout: { type: 'number', description: 'Maximum milliseconds to wait if blocking.' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_stop',
      description: 'Stop or terminate a running background task or subagent process.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'ID of the task to terminate.' },
        },
        required: ['task_id'],
      },
    },
  },
] as const

/** Internal registry of active background task outputs and running states. */
const activeBackgroundTasks = new Map<
  string,
  {
    readonly id: string
    status: 'running' | 'completed' | 'failed' | 'stopped'
    output: string
    exitCode?: number | undefined
    error?: string | undefined
  }
>()

export function registerBackgroundTask(
  id: string,
  initialOutput = '',
): {
  appendOutput: (chunk: string) => void
  finish: (code: number, error?: string) => void
  stop: () => void
} {
  activeBackgroundTasks.set(id, {
    id,
    status: 'running',
    output: initialOutput,
  })

  return {
    appendOutput: (chunk: string): void => {
      const current = activeBackgroundTasks.get(id)
      if (current !== undefined) {
        current.output += chunk
      }
    },
    finish: (code: number, error?: string): void => {
      const current = activeBackgroundTasks.get(id)
      if (current !== undefined) {
        current.status = code === 0 ? 'completed' : 'failed'
        current.exitCode = code
        current.error = error
      }
    },
    stop: (): void => {
      const current = activeBackgroundTasks.get(id)
      if (current !== undefined) {
        current.status = 'stopped'
      }
    },
  }
}

export async function todoWriteTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const rawTodos = args.todos
  if (!Array.isArray(rawTodos)) {
    return { ok: false, content: 'todo_write requires a "todos" array.' }
  }

  const normalized: TodoItem[] = rawTodos.map((item, index) => {
    const record =
      typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const content =
      typeof record.content === 'string' ? record.content : `Task ${String(index + 1)}`
    const rawStatus = typeof record.status === 'string' ? record.status : 'pending'
    const status = rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'pending'
    const id =
      typeof record.id === 'string' && record.id.trim() !== ''
        ? record.id
        : `todo-${String(index + 1)}`

    return { id, content, status }
  })

  const forgeDir = join(context.workspacePath, '.forge')
  await mkdir(forgeDir, { recursive: true }).catch(() => undefined)
  const filePath = join(forgeDir, 'todos.json')
  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8')

  const pending = normalized.filter((t) => t.status === 'pending').length
  const inProgress = normalized.filter((t) => t.status === 'in_progress').length
  const completed = normalized.filter((t) => t.status === 'completed').length

  const checklist = normalized
    .map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[-]' : '[ ]'
      return `${mark} ${t.content}`
    })
    .join('\n')

  return {
    ok: true,
    content: `Updated todo checklist (${String(completed)} completed, ${String(inProgress)} in progress, ${String(pending)} pending):\n${checklist}`,
  }
}

export async function taskCreateTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
  const description = typeof args.description === 'string' ? args.description.trim() : ''
  if (subject === '' || description === '') {
    return { ok: false, content: 'task_create requires "subject" and "description".' }
  }

  const tasksDir = join(context.workspacePath, '.forge', 'tasks')
  await mkdir(tasksDir, { recursive: true }).catch(() => undefined)

  const id = `task-${String(Date.now())}-${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  const activeForm = typeof args.activeForm === 'string' ? args.activeForm : undefined
  const metadata =
    typeof args.metadata === 'object' && args.metadata !== null
      ? (args.metadata as Record<string, unknown>)
      : undefined

  const task: TaskItem = {
    id,
    subject,
    description,
    activeForm,
    status: 'pending',
    metadata,
    createdAt: now,
    updatedAt: now,
  }

  await writeFile(join(tasksDir, `${id}.json`), JSON.stringify(task, null, 2), 'utf8')

  return {
    ok: true,
    content: JSON.stringify({ task: { id: task.id, subject: task.subject, status: task.status } }),
  }
}

export async function taskGetTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (taskId === '') {
    return { ok: false, content: 'task_get requires "task_id".' }
  }

  const cleanId = taskId.replace(/[^a-zA-Z0-9_-]/g, '')
  const filePath = join(context.workspacePath, '.forge', 'tasks', `${cleanId}.json`)
  const raw = await readFile(filePath, 'utf8').catch(() => null)
  if (raw === null) {
    return { ok: false, content: `Task "${taskId}" not found.` }
  }

  return { ok: true, content: raw }
}

export async function taskListTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const filter = typeof args.status === 'string' ? args.status : 'all'
  const tasksDir = join(context.workspacePath, '.forge', 'tasks')
  const files = await readdir(tasksDir).catch(() => [])

  const tasks: TaskItem[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const raw = await readFile(join(tasksDir, file), 'utf8').catch(() => null)
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw) as TaskItem
      if (filter === 'all' || parsed.status === filter) {
        tasks.push(parsed)
      }
    } catch {
      // Ignore malformed files
    }
  }

  return {
    ok: true,
    content: JSON.stringify(
      tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        activeForm: t.activeForm,
      })),
      null,
      2,
    ),
  }
}

export async function taskUpdateTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (taskId === '') {
    return { ok: false, content: 'task_update requires "task_id".' }
  }

  const cleanId = taskId.replace(/[^a-zA-Z0-9_-]/g, '')
  const filePath = join(context.workspacePath, '.forge', 'tasks', `${cleanId}.json`)
  const raw = await readFile(filePath, 'utf8').catch(() => null)
  if (raw === null) {
    return { ok: false, content: `Task "${taskId}" not found.` }
  }

  try {
    const task = JSON.parse(raw) as TaskItem
    const status =
      typeof args.status === 'string' &&
      ['pending', 'in_progress', 'completed', 'deleted'].includes(args.status)
        ? (args.status as TaskItem['status'])
        : task.status
    const subject =
      typeof args.subject === 'string' && args.subject.trim() !== ''
        ? args.subject.trim()
        : task.subject
    const description =
      typeof args.description === 'string' && args.description.trim() !== ''
        ? args.description.trim()
        : task.description
    const metadata =
      typeof args.metadata === 'object' && args.metadata !== null
        ? { ...task.metadata, ...(args.metadata as Record<string, unknown>) }
        : task.metadata

    const updated: TaskItem = {
      ...task,
      status,
      subject,
      description,
      metadata,
      updatedAt: new Date().toISOString(),
    }

    if (status === 'deleted') {
      await unlink(filePath).catch(() => undefined)
      return { ok: true, content: `Task "${taskId}" deleted.` }
    }

    await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8')
    return {
      ok: true,
      content: JSON.stringify({
        task: { id: updated.id, subject: updated.subject, status: updated.status },
      }),
    }
  } catch (err) {
    return {
      ok: false,
      content: `Failed to update task: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function taskOutputTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (taskId === '') {
    return Promise.resolve({ ok: false, content: 'task_output requires "task_id".' })
  }

  const task = activeBackgroundTasks.get(taskId)
  if (task === undefined) {
    return Promise.resolve({
      ok: true,
      content: JSON.stringify({
        task_id: taskId,
        status: 'not_found_or_finished',
        output: `No active background task found for "${taskId}".`,
      }),
    })
  }

  return Promise.resolve({
    ok: true,
    content: JSON.stringify({
      task_id: task.id,
      status: task.status,
      output: task.output,
      exitCode: task.exitCode ?? null,
    }),
  })
}

export function taskStopTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (taskId === '') {
    return Promise.resolve({ ok: false, content: 'task_stop requires "task_id".' })
  }

  const task = activeBackgroundTasks.get(taskId)
  if (task !== undefined) {
    task.status = 'stopped'
  }

  return Promise.resolve({
    ok: true,
    content: `Task "${taskId}" stopped.`,
  })
}

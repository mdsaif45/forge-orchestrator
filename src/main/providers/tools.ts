import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { matchesAny } from '@shared/domain'

/**
 * The tools a hosted model is given, and the rules they run under.
 *
 * A CLI agent brings its own tools; Forge hosts it and verifies afterwards. A
 * raw model has none, which is why a local Qwen asked to describe a repository
 * replied "no direct access to your repository in this environment" and guessed
 * at filenames. This module is the missing half: real filesystem and command
 * access, behind the same scope and permission rules Forge already enforces on
 * every other agent.
 *
 * Every path is resolved and checked before use. The checks are not advisory —
 * a model is untrusted input, and the interesting failure is not a model that
 * refuses to work but one that cheerfully writes outside the worktree.
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
}

/** The JSON-schema tool declarations sent to the model. */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the workspace. Use this before answering any question about code — never guess a file’s contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the entries of a directory in the workspace. Use "." for the root. Directories are suffixed with a slash.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Find files whose name matches a substring. Use this to locate a file before reading it, rather than assuming a path.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring of the filename.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a UTF-8 text file in the workspace. Only paths inside the task’s declared scope are permitted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'The complete new file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its output. Use it for builds, tests and git reads.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
        },
        required: ['command'],
      },
    },
  },
] as const

/** Largest file body handed to a model, and the cap on command output. */
const MAX_READ_BYTES = 64 * 1024
const MAX_OUTPUT_CHARS = 16 * 1024
const MAX_LIST_ENTRIES = 300
const MAX_SEARCH_RESULTS = 50
/** Directories never worth walking, and expensive enough to matter on a real repo. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', 'out-dev', '.next'])

/**
 * Resolves a model-supplied path inside the workspace, or refuses it.
 *
 * The containment check compares resolved paths rather than inspecting the input
 * for `..`, because string inspection misses the cases that matter: an absolute
 * path, a symlink-shaped input, or a separator the host normalises differently.
 * Returns null for anything that escapes.
 */
export function resolveInWorkspace(workspacePath: string, candidate: string): string | null {
  if (candidate.trim() === '') return null

  const root = resolve(workspacePath)
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const rel = relative(root, target)

  // Empty means the root itself, which is legitimate for list_dir.
  if (rel === '') return target
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  // A path segment that resolves outside on this platform's separator rules.
  if (rel.split(sep).includes('..')) return null

  return target
}

/** Whether a write to this workspace-relative path is permitted by the task's scope. */
export function isWriteAllowed(
  relativePath: string,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): boolean {
  // Forbidden wins over allowed, so an overlapping pair is refused rather than
  // resolved by ordering.
  if (matchesAny(relativePath, forbiddenPaths)) return false
  // No declared scope means nothing is in scope. Treating an empty list as
  // "everything" would turn a task that forgot to declare paths into an
  // unrestricted one, which is the opposite of the intended default (A7).
  if (allowedPaths.length === 0) return false
  return matchesAny(relativePath, allowedPaths)
}

/** Posix-style separators, so a glob written with `/` matches on Windows too. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… truncated at ${String(limit)} characters.`
}

/**
 * Executes one tool call.
 *
 * Never throws: a model that receives an exception learns nothing, while a
 * refusal explaining what was wrong lets it correct itself on the next turn.
 */
export async function runTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file':
        return await readFileTool(args, context)
      case 'list_dir':
        return await listDirTool(args, context)
      case 'search_files':
        return await searchFilesTool(args, context)
      case 'write_file':
        return await writeFileTool(args, context)
      case 'run_command':
        return await runCommandTool(args, context)
      default:
        return { ok: false, content: `Unknown tool "${name}".` }
    }
  } catch (err) {
    return {
      ok: false,
      content: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' ? value : null
}

async function readFileTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const path = stringArg(args, 'path')
  if (path === null) return { ok: false, content: 'read_file needs a string "path".' }

  const target = resolveInWorkspace(context.workspacePath, path)
  if (target === null) {
    return { ok: false, content: `Refused: "${path}" is outside the workspace.` }
  }

  const info = await stat(target).catch(() => null)
  if (info === null) return { ok: false, content: `No such file: ${path}` }
  if (info.isDirectory()) {
    return { ok: false, content: `${path} is a directory. Use list_dir.` }
  }

  const body = await readFile(target, 'utf8')
  return { ok: true, content: truncate(body, MAX_READ_BYTES) }
}

async function listDirTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const path = stringArg(args, 'path') ?? '.'
  const target = resolveInWorkspace(context.workspacePath, path)
  if (target === null) {
    return { ok: false, content: `Refused: "${path}" is outside the workspace.` }
  }

  const entries = await readdir(target, { withFileTypes: true }).catch(() => null)
  if (entries === null) return { ok: false, content: `Cannot list ${path}` }

  const listed = entries
    .filter((entry) => !SKIP_DIRECTORIES.has(entry.name))
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()

  return {
    ok: true,
    content: listed.length === 0 ? '(empty)' : listed.join('\n'),
  }
}

async function searchFilesTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const query = stringArg(args, 'query')
  if (query === null) return { ok: false, content: 'search_files needs a string "query".' }

  const needle = query.toLowerCase()
  const root = resolve(context.workspacePath)
  const found: string[] = []

  const walk = async (directory: string): Promise<void> => {
    if (found.length >= MAX_SEARCH_RESULTS) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (found.length >= MAX_SEARCH_RESULTS) return
      if (SKIP_DIRECTORIES.has(entry.name)) continue

      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.name.toLowerCase().includes(needle)) {
        found.push(toPosix(relative(root, full)))
      }
    }
  }

  await walk(root)
  return {
    ok: true,
    content: found.length === 0 ? `No file matching "${query}".` : found.sort().join('\n'),
  }
}

async function writeFileTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const path = stringArg(args, 'path')
  const content = stringArg(args, 'content')
  if (path === null || content === null) {
    return { ok: false, content: 'write_file needs string "path" and "content".' }
  }

  // The role's own permission, decided from the binding rather than from
  // anything the model said about itself (A7).
  if (!context.canWrite) {
    return { ok: false, content: 'Refused: this role has no file-write permission.' }
  }

  const target = resolveInWorkspace(context.workspacePath, path)
  if (target === null) {
    return { ok: false, content: `Refused: "${path}" is outside the workspace.` }
  }

  const rel = toPosix(relative(resolve(context.workspacePath), target))
  if (!isWriteAllowed(rel, context.allowedPaths, context.forbiddenPaths)) {
    return {
      ok: false,
      content: `Refused: "${rel}" is outside the task scope (allowed: ${
        context.allowedPaths.length === 0 ? 'none declared' : context.allowedPaths.join(', ')
      }).`,
    }
  }

  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
  return { ok: true, content: `Wrote ${rel} (${String(content.length)} characters).` }
}

async function runCommandTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const command = stringArg(args, 'command')
  if (command === null) return { ok: false, content: 'run_command needs a string "command".' }

  if (context.runCommand === undefined) {
    // Stated rather than silently returning nothing: a model told "no output"
    // would conclude the command succeeded.
    return { ok: false, content: 'Refused: command execution is not enabled for this session.' }
  }

  const { output, code } = await context.runCommand(command, context.workspacePath)
  return {
    ok: code === 0,
    content: truncate(
      `exit ${String(code)}\n${output === '' ? '(no output)' : output}`,
      MAX_OUTPUT_CHARS,
    ),
  }
}

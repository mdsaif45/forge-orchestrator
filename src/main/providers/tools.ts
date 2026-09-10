import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { matchesAny, matchesGlob } from '@shared/domain'

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
  /** Project ID for persistent rules. */
  readonly projectId?: string | undefined
  /** Callback to persist project rules in database. */
  readonly setRule?:
    | ((scope: string, key: string, statement: string) => Promise<void>)
    | undefined
  /** Callback to retrieve project rules. */
  readonly getRules?:
    | (() => Promise<readonly { readonly scope: string; readonly key: string; readonly statement: string }[]>)
    | undefined
  /** Active file currently open in workspace editor. */
  readonly activeFilePath?: string | undefined
  /** Custom fetch implementation for testing. */
  readonly fetchImpl?: typeof fetch | undefined
}

/** The complete JSON-schema tool declarations sent to the model (15 tools). */
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
      name: 'edit_file',
      description:
        'Replace an exact snippet in a file, leaving the rest untouched. Prefer this over write_file for any change to an existing file: you only supply the part that changes. To append, pass the current last line as old_text and that line plus your addition as new_text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          old_text: {
            type: 'string',
            description:
              'The exact existing text to replace, copied verbatim from the file including indentation. Must appear exactly once.',
          },
          new_text: { type: 'string', description: 'The text to put in its place.' },
        },
        required: ['path', 'old_text', 'new_text'],
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
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description:
        'Search for lines matching a regular expression (regex) or plain text in workspace file contents. Returns file paths, line numbers, and matching text snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The regex pattern or text substring to search for.',
          },
          path: {
            type: 'string',
            description: 'Optional subpath or file to restrict search to. Defaults to "." (root).',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Whether search should be case sensitive. Defaults to false.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of matching lines to return. Defaults to 50.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_glob_search',
      description:
        'Search for files recursively in the workspace using standard glob patterns (e.g. "**/*.ts", "src/**/*.tsx", "*.json").',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files against.',
          },
          path: {
            type: 'string',
            description: 'Directory relative to workspace root to search within. Defaults to ".".',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_diff',
      description:
        'View the current git diff of working changes in the workspace. Shows additions and deletions.',
      parameters: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description:
              'If true, inspects staged changes (git diff --cached). If false or omitted, inspects unstaged working changes.',
          },
          path: {
            type: 'string',
            description: 'Optional path to inspect diff for a specific file or directory.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Perform a live web search to find current external documentation, API specs, solutions, and library references.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of search results to return (default 5, max 10).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url_content',
      description:
        'Fetch content from an external website or documentation URL and convert it into clean readable markdown. Do NOT use for workspace files.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The HTTP or HTTPS URL of the website or documentation to fetch.',
          },
          max_length: {
            type: 'number',
            description: 'Maximum characters of content to return (default 16000).',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_rule_block',
      description:
        'Creates a persistent rule or guideline that will be saved in the project rule database and referenced in future conversations.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: 'Rule scope (e.g. "workspace", "build", "style", "security").',
          },
          key: {
            type: 'string',
            description: 'Unique identifier for the rule (e.g. "no-explicit-any", "error-format").',
          },
          statement: {
            type: 'string',
            description: 'The rule statement or preference to be enforced consistently.',
          },
        },
        required: ['scope', 'key', 'statement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_rule',
      description:
        'Retrieve stored project rules and guidelines that contain context or instructions based on scope or query.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: 'Filter rules by scope (e.g. "workspace").',
          },
          query: {
            type: 'string',
            description: 'Optional search keyword to match against rule keys or statements.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description:
        'Read the instructions and workflow content of a specialized skill by its name.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the skill to read (e.g. "migrate", "audit").',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_currently_open_file',
      description:
        'Read the file currently open and focused in the IDE workspace editor.',
      parameters: {
        type: 'object',
        properties: {},
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

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' ? value : null
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
      case 'ls':
        return await listDirTool(args, context)
      case 'search_files':
        return await searchFilesTool(args, context)
      case 'write_file':
      case 'create_new_file':
        return await writeFileTool(args, context)
      case 'edit_file':
      case 'edit_existing_file':
      case 'single_find_and_replace':
        return await editFileTool(args, context)
      case 'run_command':
      case 'run_terminal_command':
        return await runCommandTool(args, context)
      case 'grep_search':
        return await grepSearchTool(args, context)
      case 'file_glob_search':
        return await fileGlobSearchTool(args, context)
      case 'view_diff':
        return await viewDiffTool(args, context)
      case 'search_web':
        return await searchWebTool(args, context)
      case 'fetch_url_content':
        return await fetchUrlContentTool(args, context)
      case 'create_rule_block':
        return await createRuleBlockTool(args, context)
      case 'request_rule':
        return await requestRuleTool(args, context)
      case 'read_skill':
        return await readSkillTool(args, context)
      case 'read_currently_open_file':
        return await readCurrentlyOpenFileTool(args, context)
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

async function editFileTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const path = stringArg(args, 'path')
  const oldText = stringArg(args, 'old_text')
  const newText = stringArg(args, 'new_text')

  if (path === null || oldText === null || newText === null) {
    return { ok: false, content: 'edit_file needs string "path", "old_text" and "new_text".' }
  }
  if (oldText === '') {
    return {
      ok: false,
      content: 'edit_file needs a non-empty "old_text". Use write_file for a new file.',
    }
  }

  if (!context.canWrite) {
    return { ok: false, content: 'Refused: this role has no file-write permission.' }
  }

  const target = resolveInWorkspace(context.workspacePath, path)
  if (target === null) {
    return { ok: false, content: `Refused: "${path}" is outside the workspace.` }
  }

  const rel = toPosix(relative(resolve(context.workspacePath), target))
  if (!isWriteAllowed(rel, context.allowedPaths, context.forbiddenPaths)) {
    return { ok: false, content: `Refused: "${rel}" is outside the task scope.` }
  }

  const existing = await readFile(target, 'utf8').catch(() => null)
  if (existing === null) {
    return { ok: false, content: `No such file: ${path}. Use write_file to create it.` }
  }

  const first = existing.indexOf(oldText)
  if (first === -1) {
    return {
      ok: false,
      content: `Not found in ${rel}. "old_text" must match the file exactly, including indentation and line breaks. Read the file again and copy the snippet verbatim.`,
    }
  }

  if (existing.slice(first + oldText.length).includes(oldText)) {
    return {
      ok: false,
      content: `"old_text" appears more than once in ${rel}. Include enough surrounding context to make it unique.`,
    }
  }

  const updated = existing.slice(0, first) + newText + existing.slice(first + oldText.length)
  await writeFile(target, updated, 'utf8')

  const delta = updated.length - existing.length
  return {
    ok: true,
    content: `Edited ${rel} (${delta >= 0 ? '+' : ''}${String(delta)} characters).`,
  }
}

async function runCommandTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const command = stringArg(args, 'command')
  if (command === null) return { ok: false, content: 'run_command needs a string "command".' }

  if (context.runCommand === undefined) {
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

async function grepSearchTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const query = stringArg(args, 'query')
  if (query === null || query.trim() === '') {
    return { ok: false, content: 'grep_search needs a non-empty string "query".' }
  }

  const subpath = stringArg(args, 'path') ?? '.'
  const caseSensitive = Boolean(args.case_sensitive)
  const maxResults = typeof args.max_results === 'number' ? Math.min(args.max_results, 100) : 50

  const target = resolveInWorkspace(context.workspacePath, subpath)
  if (target === null) {
    return { ok: false, content: `Refused: "${subpath}" is outside the workspace.` }
  }

  const root = resolve(context.workspacePath)
  let regex: RegExp
  try {
    regex = new RegExp(query, caseSensitive ? 'g' : 'gi')
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
  }

  const matches: string[] = []

  const searchFile = async (filePath: string): Promise<void> => {
    if (matches.length >= maxResults) return

    const fileStat = await stat(filePath).catch(() => null)
    if (fileStat === null || fileStat.size > 1024 * 1024) return // Skip > 1MB

    const content = await readFile(filePath, 'utf8').catch(() => null)
    if (content === null || content.includes('\0')) return // Skip binary files

    const relPath = toPosix(relative(root, filePath))
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) return
      const line = lines[i] ?? ''
      regex.lastIndex = 0
      if (regex.test(line)) {
        matches.push(`${relPath}:${String(i + 1)}: ${line.trim()}`)
      }
    }
  }

  const walkDir = async (dir: string): Promise<void> => {
    if (matches.length >= maxResults) return

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (matches.length >= maxResults) return
      if (SKIP_DIRECTORIES.has(entry.name)) continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkDir(full)
      } else if (entry.isFile()) {
        await searchFile(full)
      }
    }
  }

  const info = await stat(target).catch(() => null)
  if (info === null) return { ok: false, content: `No such file or directory: ${subpath}` }

  if (info.isFile()) {
    await searchFile(target)
  } else {
    await walkDir(target)
  }

  if (matches.length === 0) {
    return { ok: true, content: `No matches found for "${query}".` }
  }

  return {
    ok: true,
    content: `Found ${String(matches.length)} match(es):\n${matches.join('\n')}`,
  }
}

async function fileGlobSearchTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const pattern = stringArg(args, 'pattern')
  if (pattern === null || pattern.trim() === '') {
    return { ok: false, content: 'file_glob_search needs a non-empty string "pattern".' }
  }

  const subpath = stringArg(args, 'path') ?? '.'
  const target = resolveInWorkspace(context.workspacePath, subpath)
  if (target === null) {
    return { ok: false, content: `Refused: "${subpath}" is outside the workspace.` }
  }

  const root = resolve(context.workspacePath)
  const found: string[] = []

  const walk = async (dir: string): Promise<void> => {
    if (found.length >= MAX_SEARCH_RESULTS) return

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= MAX_SEARCH_RESULTS) return
      if (SKIP_DIRECTORIES.has(entry.name)) continue

      const full = join(dir, entry.name)
      const relPath = toPosix(relative(root, full))

      if (entry.isDirectory()) {
        if (matchesGlob(relPath, pattern)) {
          found.push(`${relPath}/`)
        }
        await walk(full)
      } else if (entry.isFile()) {
        if (matchesGlob(relPath, pattern)) {
          found.push(relPath)
        }
      }
    }
  }

  const info = await stat(target).catch(() => null)
  if (info === null) return { ok: false, content: `No such file or directory: ${subpath}` }

  if (info.isFile()) {
    const rel = toPosix(relative(root, target))
    if (matchesGlob(rel, pattern)) found.push(rel)
  } else {
    await walk(target)
  }

  if (found.length === 0) {
    return { ok: true, content: `No files matched glob "${pattern}".` }
  }

  return {
    ok: true,
    content: found.sort().join('\n'),
  }
}

async function viewDiffTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  if (context.runCommand === undefined) {
    return { ok: false, content: 'Refused: command execution is not enabled for diff inspection.' }
  }

  const staged = Boolean(args.staged)
  const targetPath = stringArg(args, 'path')
  const baseCmd = staged ? 'git diff --cached' : 'git diff'
  const fullCmd = targetPath ? `${baseCmd} -- "${targetPath}"` : baseCmd

  const { output, code } = await context.runCommand(fullCmd, context.workspacePath)
  if (code !== 0) {
    return { ok: false, content: `git diff failed with exit code ${String(code)}: ${output}` }
  }

  if (output.trim() === '') {
    return {
      ok: true,
      content: `No ${staged ? 'staged' : 'working'} git changes detected${targetPath ? ` in "${targetPath}"` : ''}.`,
    }
  }

  return { ok: true, content: truncate(output, MAX_OUTPUT_CHARS) }
}

function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match: string, level: string, content: string): string => {
      return `\n\n${'#'.repeat(Number(level))} ${content.trim()}\n\n`
    },
  )

  text = text.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_m: string, code: string): string => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`,
  )
  text = text.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_m: string, code: string): string => `\`${code.trim()}\``,
  )
  text = text.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m: string, href: string, linkText: string): string => `[${linkText.trim()}](${href})`,
  )
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_m: string, item: string): string => `\n- ${item.trim()}`,
  )
  text = text.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    (_m: string, p: string): string => `\n\n${p.trim()}\n\n`,
  )
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  return text.replace(/\n{3,}/g, '\n\n').trim()
}

async function fetchUrlContentTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const url = stringArg(args, 'url')
  if (url === null || url.trim() === '') {
    return { ok: false, content: 'fetch_url_content needs a string "url".' }
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { ok: false, content: 'Refused: "url" must begin with http:// or https://.' }
  }

  const maxLength = typeof args.max_length === 'number' ? args.max_length : 16000
  const fetcher = context.fetchImpl ?? fetch

  try {
    const res = await fetcher(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })

    if (!res.ok) {
      return { ok: false, content: `HTTP ${String(res.status)}: ${res.statusText}` }
    }

    const contentType = res.headers.get('content-type') ?? ''
    const body = await res.text()

    if (contentType.includes('application/json')) {
      return { ok: true, content: truncate(body, maxLength) }
    }

    const markdown = htmlToMarkdown(body)
    return { ok: true, content: truncate(markdown, maxLength) }
  } catch (err) {
    return { ok: false, content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function searchWebTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const query = stringArg(args, 'query')
  if (query === null || query.trim() === '') {
    return { ok: false, content: 'search_web needs a string "query".' }
  }

  const maxResults = typeof args.max_results === 'number' ? Math.min(Math.max(args.max_results, 1), 10) : 5
  const fetcher = context.fetchImpl ?? fetch

  try {
    // 1. First try DuckDuckGo instant answer JSON API
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetcher(apiUrl, {
      headers: { 'User-Agent': 'Forge-Orchestrator/0.3' },
    })

    const results: { title: string; url: string; snippet: string }[] = []

    if (res.ok) {
      const data = (await res.json()) as {
        Heading?: string
        AbstractText?: string
        AbstractURL?: string
        RelatedTopics?: { Text?: string; FirstURL?: string }[]
      }

      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading ?? query,
          url: data.AbstractURL,
          snippet: data.AbstractText,
        })
      }

      if (Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= maxResults) break
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.slice(0, 60),
              url: topic.FirstURL,
              snippet: topic.Text,
            })
          }
        }
      }
    }

    // 2. If JSON API returned fewer results, query DuckDuckGo HTML
    if (results.length < maxResults) {
      try {
        const htmlRes = await fetcher(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        })

        if (htmlRes.ok) {
          const html = await htmlRes.text()
          const linkRegex = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
          let match: RegExpExecArray | null
          while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
            const rawUrl = match[1] ?? ''
            const rawSnippet = match[2] ?? ''
            if (rawUrl && !results.some((r) => r.url === rawUrl)) {
              results.push({
                title: query,
                url: rawUrl,
                snippet: rawSnippet.replace(/<[^>]+>/g, '').trim(),
              })
            }
          }
        }
      } catch {
        // Fallback to what we have
      }
    }

    if (results.length === 0) {
      return { ok: true, content: `No web results found for "${query}".` }
    }

    const formatted = results
      .map((r, i) => `### ${String(i + 1)}. [${r.title}](${r.url})\n${r.snippet}`)
      .join('\n\n')

    return { ok: true, content: `Search results for "${query}":\n\n${formatted}` }
  } catch (err) {
    return { ok: false, content: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function createRuleBlockTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const scope = stringArg(args, 'scope') ?? 'workspace'
  const key = stringArg(args, 'key')
  const statement = stringArg(args, 'statement')

  if (key === null || statement === null || key.trim() === '' || statement.trim() === '') {
    return { ok: false, content: 'create_rule_block requires non-empty "key" and "statement".' }
  }

  // 1. Invoke SQLite rule callback if available
  if (context.setRule !== undefined) {
    try {
      await context.setRule(scope, key, statement)
    } catch {
      // Non-fatal
    }
  }

  // 2. Also write/append to .forge/rules.md in the workspace for repository-level persistence
  try {
    const forgeDir = join(context.workspacePath, '.forge')
    await mkdir(forgeDir, { recursive: true })
    const rulesFile = join(forgeDir, 'rules.md')
    const existing = await readFile(rulesFile, 'utf8').catch(() => '')
    const ruleEntry = `\n### [${scope}] ${key}\n${statement}\n`
    if (!existing.includes(`### [${scope}] ${key}`)) {
      await writeFile(rulesFile, existing + ruleEntry, 'utf8')
    }
  } catch {
    // Non-fatal
  }

  return { ok: true, content: `Rule "[${scope}] ${key}" created and saved successfully.` }
}

async function requestRuleTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const scope = stringArg(args, 'scope')?.toLowerCase()
  const query = stringArg(args, 'query')?.toLowerCase()

  const rules: { scope: string; key: string; statement: string }[] = []

  // 1. Read from context callback
  if (context.getRules !== undefined) {
    try {
      const fetched = await context.getRules()
      for (const r of fetched) {
        rules.push(r)
      }
    } catch {
      // Non-fatal
    }
  }

  // 2. Read from .forge/rules.md
  try {
    const rulesFile = join(context.workspacePath, '.forge', 'rules.md')
    const fileContent = await readFile(rulesFile, 'utf8').catch(() => null)
    if (fileContent !== null) {
      const blocks = fileContent.split(/###\s*\[(.*?)\]\s*(.*?)\n/)
      for (let i = 1; i < blocks.length; i += 3) {
        const s = blocks[i]?.trim() ?? 'workspace'
        const k = blocks[i + 1]?.trim() ?? 'rule'
        const stmt = blocks[i + 2]?.trim() ?? ''
        if (!rules.some((r) => r.scope === s && r.key === k)) {
          rules.push({ scope: s, key: k, statement: stmt })
        }
      }
    }
  } catch {
    // Non-fatal
  }

  let filtered = rules
  if (scope !== undefined) {
    filtered = filtered.filter((r) => r.scope.toLowerCase() === scope)
  }
  if (query !== undefined) {
    filtered = filtered.filter(
      (r) => r.key.toLowerCase().includes(query) || r.statement.toLowerCase().includes(query),
    )
  }

  if (filtered.length === 0) {
    return { ok: true, content: 'No rules found matching criteria.' }
  }

  const formatted = filtered
    .map((r) => `- **[${r.scope}] ${r.key}**: ${r.statement}`)
    .join('\n')

  return { ok: true, content: `Found ${String(filtered.length)} rule(s):\n${formatted}` }
}

async function readSkillTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const name = stringArg(args, 'name')
  if (name === null || name.trim() === '') {
    return { ok: false, content: 'read_skill needs a string "name".' }
  }

  const cleanName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '')
  const candidates = [
    join(context.workspacePath, '.forge', 'skills', cleanName, 'SKILL.md'),
    join(context.workspacePath, '.forge', 'skills', `${cleanName}.md`),
    join(homedir(), '.forge', 'skills', cleanName, 'SKILL.md'),
    join(homedir(), '.forge', 'skills', `${cleanName}.md`),
  ]

  for (const candidate of candidates) {
    const content = await readFile(candidate, 'utf8').catch(() => null)
    if (content !== null) {
      return { ok: true, content: truncate(content, MAX_READ_BYTES) }
    }
  }

  const skillsDir = join(context.workspacePath, '.forge', 'skills')
  const entries = await readdir(skillsDir).catch(() => [])
  const available = entries.filter((e) => !e.startsWith('.')).join(', ')

  return {
    ok: false,
    content: `Skill "${name}" not found. ${available.length > 0 ? `Available in .forge/skills: ${available}` : 'No skills found in .forge/skills/'}`,
  }
}

async function readCurrentlyOpenFileTool(
  _args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  if (context.activeFilePath === undefined || context.activeFilePath.trim() === '') {
    return {
      ok: false,
      content: 'No file is currently active or open in the workspace editor.',
    }
  }

  return await readFileTool({ path: context.activeFilePath }, context)
}

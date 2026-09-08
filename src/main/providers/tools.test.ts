import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { isWriteAllowed, resolveInWorkspace, runTool, type ToolContext } from './tools'

/**
 * The tools a hosted model is handed.
 *
 * Weighted towards refusals rather than happy paths, because a model is
 * untrusted input: the failure that matters is not one that cannot read a file,
 * it is one that writes outside the worktree or outside the task's scope.
 */

const dirs: string[] = []

const makeWorkspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'forge-tools-'))
  dirs.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'math.ts'), 'export const answer = 40\n')
  writeFileSync(join(root, 'README.md'), '# demo\n')
  return root
}

const context = (root: string, overrides: Partial<ToolContext> = {}): ToolContext => ({
  workspacePath: root,
  allowedPaths: ['src/**'],
  forbiddenPaths: [],
  canWrite: true,
  ...overrides,
})

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir)
})

describe('resolveInWorkspace', () => {
  it('resolves a relative path inside the workspace', () => {
    expect(resolveInWorkspace('D:/repo', 'src/a.ts')).not.toBeNull()
  })

  it('refuses a traversal out of the workspace', () => {
    expect(resolveInWorkspace('D:/repo', '../secrets.txt')).toBeNull()
    expect(resolveInWorkspace('D:/repo', 'src/../../etc/passwd')).toBeNull()
  })

  it('refuses an absolute path pointing elsewhere', () => {
    // Checked on the resolved path rather than by looking for ".." in the input,
    // which an absolute path contains none of.
    expect(resolveInWorkspace('D:/repo', 'C:/Windows/System32/config')).toBeNull()
  })

  it('allows an absolute path that is genuinely inside', () => {
    expect(resolveInWorkspace('D:/repo', 'D:/repo/src/a.ts')).not.toBeNull()
  })

  it('treats the workspace root itself as resolvable', () => {
    expect(resolveInWorkspace('D:/repo', '.')).not.toBeNull()
  })

  it('refuses an empty path', () => {
    expect(resolveInWorkspace('D:/repo', '   ')).toBeNull()
  })
})

describe('isWriteAllowed', () => {
  it('permits a path inside the declared scope', () => {
    expect(isWriteAllowed('src/math.ts', ['src/**'], [])).toBe(true)
  })

  it('refuses a path outside the declared scope', () => {
    expect(isWriteAllowed('package.json', ['src/**'], [])).toBe(false)
  })

  it('lets forbidden win over allowed', () => {
    // An overlapping pair is refused rather than settled by ordering, so a
    // forbidden entry cannot be defeated by a broader allow.
    expect(isWriteAllowed('src/secret.ts', ['src/**'], ['src/secret.ts'])).toBe(false)
  })

  it('treats an empty scope as nothing in scope, not everything', () => {
    // The consequential default: a task that declared no paths must not become
    // an unrestricted one (A7).
    expect(isWriteAllowed('src/math.ts', [], [])).toBe(false)
  })
})

describe('read_file', () => {
  it('returns the real contents', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_file', { path: 'src/math.ts' }, context(root))

    expect(result.ok).toBe(true)
    expect(result.content).toContain('answer = 40')
  })

  it('refuses a path outside the workspace, naming why', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_file', { path: '../../secrets' }, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the workspace/i)
  })

  it('reports a missing file rather than throwing', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_file', { path: 'src/nope.ts' }, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/no such file/i)
  })

  it('points at list_dir when handed a directory', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_file', { path: 'src' }, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/list_dir/)
  })
})

describe('list_dir and search_files', () => {
  it('lists entries, marking directories', async () => {
    const root = makeWorkspace()
    const result = await runTool('list_dir', { path: '.' }, context(root))

    expect(result.content).toContain('src/')
    expect(result.content).toContain('README.md')
  })

  it('finds a file by substring', async () => {
    const root = makeWorkspace()
    const result = await runTool('search_files', { query: 'math' }, context(root))

    expect(result.ok).toBe(true)
    expect(result.content).toContain('src/math.ts')
  })

  it('says so when nothing matches, rather than returning an empty success', async () => {
    const root = makeWorkspace()
    const result = await runTool('search_files', { query: 'zzz' }, context(root))

    expect(result.content).toMatch(/no file matching/i)
  })

  it('skips node_modules and .git while walking', async () => {
    // Correctness as much as speed: a match inside node_modules is never the
    // file the user meant, and .git contains no source at all.
    const root = makeWorkspace()
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'math.ts'), 'x')

    const result = await runTool('search_files', { query: 'math' }, context(root))

    expect(result.content).toContain('src/math.ts')
    expect(result.content).not.toContain('node_modules')
  })
})

describe('write_file', () => {
  it('writes a file inside the scope', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'write_file',
      { path: 'src/math.ts', content: 'export const answer = 42\n' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(readFileSync(join(root, 'src', 'math.ts'), 'utf8')).toContain('42')
  })

  it('creates missing parent directories', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'write_file',
      { path: 'src/deep/new.ts', content: 'x\n' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(readFileSync(join(root, 'src', 'deep', 'new.ts'), 'utf8')).toBe('x\n')
  })

  it('refuses a write outside the task scope, and does not create the file', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'write_file',
      { path: 'package.json', content: '{}' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the task scope/i)
    // The refusal has to be real, not just reported.
    expect(() => readFileSync(join(root, 'package.json'), 'utf8')).toThrow()
  })

  it('refuses a write outside the workspace entirely', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'write_file',
      { path: '../escaped.ts', content: 'x' },
      context(root, { allowedPaths: ['**'] }),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the workspace/i)
  })

  it('refuses a role with no write permission', async () => {
    // The gate is the binding's permission, not anything the model claims about
    // itself — a planner that decides to edit is still a planner.
    const root = makeWorkspace()
    const result = await runTool(
      'write_file',
      { path: 'src/math.ts', content: 'x' },
      context(root, { canWrite: false }),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/no file-write permission/i)
    expect(readFileSync(join(root, 'src', 'math.ts'), 'utf8')).toContain('40')
  })
})

describe('run_command', () => {
  it('reports output and exit code', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'run_command',
      { command: 'echo hi' },
      context(root, {
        runCommand: () => Promise.resolve({ output: 'hi', code: 0 }),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('exit 0')
    expect(result.content).toContain('hi')
  })

  it('marks a non-zero exit as failed so the model does not read it as success', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'run_command',
      { command: 'false' },
      context(root, {
        runCommand: () => Promise.resolve({ output: 'boom', code: 1 }),
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain('exit 1')
  })

  it('says command execution is unavailable rather than returning nothing', async () => {
    const root = makeWorkspace()
    const result = await runTool('run_command', { command: 'ls' }, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not enabled/i)
  })
})

describe('argument and name validation', () => {
  it('reports an unknown tool by name', async () => {
    const root = makeWorkspace()
    const result = await runTool('rm_rf', {}, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/unknown tool/i)
  })

  it('reports a missing argument instead of coercing it', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_file', { path: 42 }, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/needs a string/i)
  })
})

describe('the chat-turn write scope', () => {
  // The scope the agent turn actually uses. Kept here rather than imported so a
  // change to it has to be made deliberately in two places, and so this test
  // documents the boundary rather than restating whatever the constant says.
  const scope = [
    'src/**',
    'docs/**',
    'test/**',
    'tests/**',
    'scripts/**',
    'examples/**',
    'assets/**',
    'installer/**',
    '*.md',
    '**/*.md',
    '*.txt',
    '**/*.txt',
    '*.json',
    '*.toml',
    '*.yml',
    '*.yaml',
    'LICENSE',
    'CHANGELOG',
  ]
  const forbidden = [
    '**/.git/**',
    '**/.env*',
    '**/package-lock.json',
    '**/*.lock',
    '**/node_modules/**',
  ]
  const allowed = (path: string): boolean => isWriteAllowed(path, scope, forbidden)

  it('permits documentation at the root and nested', () => {
    // Measured failure: `*.md` alone matched README.md but not
    // assets/README.md, so a turn asked to update the README found two, was
    // refused on the nested one, and abandoned the task with no answer.
    expect(allowed('README.md')).toBe(true)
    expect(allowed('assets/README.md')).toBe(true)
    expect(allowed('docs/PLAN.md')).toBe(true)
  })

  it('permits extensionless licence and changelog files', () => {
    // The other half of the same failure: LICENSE has no extension, so no
    // pattern of the form `*.ext` could ever match it.
    expect(allowed('LICENSE')).toBe(true)
    expect(allowed('CHANGELOG')).toBe(true)
  })

  it('permits project manifests but never a lockfile', () => {
    // A manifest is edited by hand; a lockfile is generated, and hand-editing
    // one produces an install that cannot be reproduced.
    expect(allowed('Cargo.toml')).toBe(true)
    expect(allowed('package.json')).toBe(true)
    expect(allowed('package-lock.json')).toBe(false)
    expect(allowed('Cargo.lock')).toBe(false)
  })

  it('never permits secrets, git internals or dependencies', () => {
    expect(allowed('.env')).toBe(false)
    expect(allowed('.env.local')).toBe(false)
    expect(allowed('.git/config')).toBe(false)
    expect(allowed('node_modules/pkg/README.md')).toBe(false)
  })
})

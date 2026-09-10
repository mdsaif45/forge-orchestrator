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

/**
 * Absolute paths for the platform the test is running on.
 *
 * These were written as `D:/repo` and `C:/Windows/...`, which are absolute
 * only on Windows. On Linux CI they are RELATIVE, so `resolveInWorkspace`
 * joined them under the working directory and the "refuses an absolute path
 * pointing elsewhere" case asserted nothing — it passed on Windows and failed
 * on CI, which is worse than either, because the platform that ran it green
 * was the one that did not need the check.
 */
const WORKSPACE = process.platform === 'win32' ? 'D:/repo' : '/repo'
const ELSEWHERE = process.platform === 'win32' ? 'C:/Windows/System32/config' : '/etc/shadow'

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
    expect(resolveInWorkspace(WORKSPACE, 'src/a.ts')).not.toBeNull()
  })

  it('refuses a traversal out of the workspace', () => {
    expect(resolveInWorkspace(WORKSPACE, '../secrets.txt')).toBeNull()
    expect(resolveInWorkspace(WORKSPACE, 'src/../../etc/passwd')).toBeNull()
  })

  it('refuses an absolute path pointing elsewhere', () => {
    // Checked on the resolved path rather than by looking for ".." in the input,
    // which an absolute path contains none of.
    expect(resolveInWorkspace(WORKSPACE, ELSEWHERE)).toBeNull()
  })

  it('allows an absolute path that is genuinely inside', () => {
    expect(resolveInWorkspace(WORKSPACE, `${WORKSPACE}/src/a.ts`)).not.toBeNull()
  })

  it('treats the workspace root itself as resolvable', () => {
    expect(resolveInWorkspace(WORKSPACE, '.')).not.toBeNull()
  })

  it('refuses an empty path', () => {
    expect(resolveInWorkspace(WORKSPACE, '   ')).toBeNull()
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

describe('edit_file', () => {
  const withReadme = (): string => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'src', 'doc.md'), '# Title\n\nBody line\n')
    return root
  }

  it('replaces an exact snippet and leaves the rest alone', async () => {
    // The tool that makes editing possible for a small model: measured against
    // a real 7KB README, a 4B model would not attempt `write_file` at all — it
    // read the file and described the change instead of calling anything.
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/doc.md', old_text: 'Body line', new_text: 'Body line\n\n## Testing\n\nRun it.' },
      context(root),
    )

    expect(result.ok).toBe(true)
    const after = readFileSync(join(root, 'src', 'doc.md'), 'utf8')
    expect(after).toContain('# Title')
    expect(after).toContain('## Testing')
  })

  it('reports the size change, so the model can sanity-check its own edit', async () => {
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/doc.md', old_text: 'Body line', new_text: 'Body' },
      context(root),
    )

    expect(result.content).toMatch(/-5 characters/)
  })

  it('refuses a snippet that is not present, naming the likely cause', async () => {
    // A model told only "not found" retries the same near-miss; whitespace is
    // the usual culprit, so the refusal says so.
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/doc.md', old_text: 'not in the file', new_text: 'x' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/must match the file exactly/i)
  })

  it('refuses an ambiguous snippet rather than guessing which one', async () => {
    // Replacing the wrong occurrence is a silent corruption the model has no
    // way to notice, so an ambiguous match is never resolved by position.
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/doc.md', old_text: 'i', new_text: 'x' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/more than once/i)
    expect(readFileSync(join(root, 'src', 'doc.md'), 'utf8')).toContain('Body line')
  })

  it('refuses a file outside the scope', async () => {
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'README.md', old_text: '# demo', new_text: '# other' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the task scope/i)
  })

  it('refuses a role with no write permission', async () => {
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/doc.md', old_text: 'Body line', new_text: 'x' },
      context(root, { canWrite: false }),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/no file-write permission/i)
  })

  it('points at write_file when the file does not exist', async () => {
    const root = withReadme()
    const result = await runTool(
      'edit_file',
      { path: 'src/missing.md', old_text: 'a', new_text: 'b' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/write_file to create it/i)
  })
})

describe('grep_search', () => {
  it('finds matching lines with line numbers and file paths', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'grep_search',
      { query: 'answer' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('src/math.ts:1:')
    expect(result.content).toContain('answer = 40')
  })

  it('reports when no matches are found', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'grep_search',
      { query: 'nonexistent_symbol_123' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('No matches found')
  })

  it('refuses searches outside the workspace', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'grep_search',
      { query: 'hello', path: '../elsewhere' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the workspace/i)
  })
})

describe('file_glob_search', () => {
  it('finds files matching a glob pattern', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'file_glob_search',
      { pattern: '**/*.ts' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('src/math.ts')
  })

  it('reports when no files match the glob', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'file_glob_search',
      { pattern: '**/*.rs' },
      context(root),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('No files matched glob')
  })
})

describe('view_diff', () => {
  it('executes git diff via command runner', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'view_diff',
      {},
      context(root, {
        runCommand: () => Promise.resolve({ output: '+ new line in math.ts', code: 0 }),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('+ new line in math.ts')
  })

  it('reports when no changes are detected', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'view_diff',
      {},
      context(root, {
        runCommand: () => Promise.resolve({ output: '', code: 0 }),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('No working git changes detected')
  })
})

describe('fetch_url_content', () => {
  it('refuses non-http URLs', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'fetch_url_content',
      { url: 'ftp://example.com' },
      context(root),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/must begin with http:\/\/ or https:\/\//i)
  })

  it('fetches HTML and converts to clean markdown', async () => {
    const root = makeWorkspace()
    const fakeHtml = '<html><head><title>Docs</title></head><body><h1>API Reference</h1><p>Welcome to the <code>API</code>.</p><a href="https://example.com/login">Login</a></body></html>'

    const result = await runTool(
      'fetch_url_content',
      { url: 'https://docs.example.com' },
      context(root, {
        fetchImpl: () =>
          Promise.resolve(
            new Response(fakeHtml, {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
          ),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('# API Reference')
    expect(result.content).toContain('`API`')
    expect(result.content).toContain('[Login](https://example.com/login)')
  })
})

describe('search_web', () => {
  it('returns formatted web search results', async () => {
    const root = makeWorkspace()
    const fakeApiResponse = {
      Heading: 'TypeScript',
      AbstractText: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
      AbstractURL: 'https://www.typescriptlang.org',
      RelatedTopics: [],
    }

    const result = await runTool(
      'search_web',
      { query: 'typescript' },
      context(root, {
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify(fakeApiResponse), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('TypeScript')
    expect(result.content).toContain('https://www.typescriptlang.org')
  })
})

describe('create_rule_block and request_rule', () => {
  it('persists a rule and retrieves it', async () => {
    const root = makeWorkspace()
    const savedRules: { scope: string; key: string; statement: string }[] = []

    const ctx = context(root, {
      setRule: (scope, key, statement) => {
        savedRules.push({ scope, key, statement })
        return Promise.resolve()
      },
      getRules: () => Promise.resolve(savedRules),
    })

    const createRes = await runTool(
      'create_rule_block',
      { scope: 'workspace', key: 'no-any', statement: 'Do not use explicit any in TypeScript.' },
      ctx,
    )
    expect(createRes.ok).toBe(true)
    expect(savedRules).toHaveLength(1)
    expect(savedRules[0]?.key).toBe('no-any')

    const getRes = await runTool('request_rule', { query: 'explicit any' }, ctx)
    expect(getRes.ok).toBe(true)
    expect(getRes.content).toContain('no-any')
    expect(getRes.content).toContain('Do not use explicit any')
  })
})

describe('read_skill', () => {
  it('reads skill from workspace .forge/skills', async () => {
    const root = makeWorkspace()
    mkdirSync(join(root, '.forge', 'skills', 'test-skill'), { recursive: true })
    writeFileSync(join(root, '.forge', 'skills', 'test-skill', 'SKILL.md'), '# Test Skill Workflow\nStep 1: check files.\n')

    const result = await runTool('read_skill', { name: 'test-skill' }, context(root))
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Test Skill Workflow')
  })

  it('reports missing skills with list of available ones', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_skill', { name: 'missing-skill' }, context(root))
    expect(result.ok).toBe(false)
    expect(result.content).toContain('Skill "missing-skill" not found')
  })
})

describe('read_currently_open_file', () => {
  it('reads the active file when set', async () => {
    const root = makeWorkspace()
    const result = await runTool(
      'read_currently_open_file',
      {},
      context(root, { activeFilePath: 'src/math.ts' }),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('answer = 40')
  })

  it('reports when no file is active', async () => {
    const root = makeWorkspace()
    const result = await runTool('read_currently_open_file', {}, context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toContain('No file is currently active')
  })
})

describe('tool aliases', () => {
  it('supports ls, create_new_file, edit_existing_file, run_terminal_command', async () => {
    const root = makeWorkspace()
    const lsRes = await runTool('ls', { path: '.' }, context(root))
    expect(lsRes.ok).toBe(true)
    expect(lsRes.content).toContain('README.md')

    const writeRes = await runTool('create_new_file', { path: 'src/created.ts', content: 'test' }, context(root))
    expect(writeRes.ok).toBe(true)

    const editRes = await runTool('edit_existing_file', { path: 'src/created.ts', old_text: 'test', new_text: 'updated' }, context(root))
    expect(editRes.ok).toBe(true)

    const cmdRes = await runTool('run_terminal_command', { command: 'echo 123' }, context(root, {
      runCommand: (cmd) => Promise.resolve({ output: cmd, code: 0 }),
    }))
    expect(cmdRes.ok).toBe(true)
  })
})


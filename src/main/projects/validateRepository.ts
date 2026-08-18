import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RepositoryProbe, RepositoryProbeProblem } from '@shared/ipc'
import { GitService } from '../git'
import { runGit } from '../git/exec'

/**
 * Probes a directory before a project is bound to it.
 *
 * Every failure is a named reason rather than a generic "invalid path": the user is
 * being asked to fix something, and "not a git repository" and "this is a
 * subdirectory of one" call for different actions. Axiom A2 applies to Forge's own
 * reporting, not only to agents — a vague error is Forge guessing on the user's
 * behalf about what went wrong.
 *
 * The probe is advisory. It reports what it found and lets the caller decide;
 * only `dirty` and the `problems` list distinguish "cannot bind" from "worth
 * knowing". The one place a dirty tree becomes a hard refusal is
 * `GitService.snapshot()`, at the moment a base SHA is actually captured.
 */
export async function validateRepository(candidatePath: string): Promise<RepositoryProbe> {
  const problems: RepositoryProbeProblem[] = []

  const trimmed = candidatePath.trim()

  if (trimmed === '') {
    return probe({ problems: [{ code: 'empty-path', detail: 'Choose a repository folder.' }] })
  }

  // A relative path would resolve against Forge's own working directory, which is
  // not the user's, so it would silently mean somewhere unexpected.
  if (!isAbsolute(trimmed)) {
    return probe({
      problems: [
        {
          code: 'not-absolute',
          detail: 'Enter a full path, such as D:/Projects/InTime, not a relative one.',
        },
      ],
    })
  }

  let isDirectory: boolean
  let resolved: string
  try {
    isDirectory = (await stat(trimmed)).isDirectory()
    // Canonicalised once, here, so the path Forge stores is the same form git
    // reports: on Windows the input may be an 8.3 short name or differ in case,
    // and a stored variant would not match git output later.
    resolved = await realpath(trimmed)
  } catch {
    return probe({
      problems: [{ code: 'missing', detail: `Nothing exists at ${trimmed}.` }],
    })
  }

  if (!isDirectory) {
    return probe({
      problems: [{ code: 'not-a-directory', detail: `${trimmed} is a file, not a folder.` }],
    })
  }

  const git = new GitService({ repositoryPath: resolved })

  if (!(await git.isRepo())) {
    // Distinguishing these two is the whole point: "run git init" and "pick the
    // parent folder" are different instructions, and a single message covering
    // both would leave the user to work out which applies.
    const enclosing = await findEnclosingRepository(resolved)

    return probe({
      problems: [
        enclosing === null
          ? { code: 'not-a-repository', detail: `${posix(resolved)} is not a git repository.` }
          : {
              code: 'inside-repository',
              detail: `${posix(resolved)} is inside the repository at ${posix(enclosing)}. Bind that folder instead, so recorded paths match what git reports.`,
            },
      ],
    })
  }

  const [branch, headSha, status, root] = await Promise.all([
    git.currentBranch(),
    git.headSha(),
    git.status(),
    // Git's own answer is the authority on how the root is spelled, and it is the
    // form every later comparison happens against. It also expands an 8.3 short
    // name, which `realpath` does not — measured, not assumed.
    findEnclosingRepository(resolved),
  ])

  const dirtyPaths = [
    ...status.entries.map((entry) => entry.path),
    ...status.untracked,
    ...status.conflicted,
  ]

  if (headSha === null) {
    // Not a blocker: an empty repository is a legitimate thing to bind. It does
    // mean no workflow can start until there is a commit to diff against.
    problems.push({
      code: 'no-commits',
      detail:
        'This repository has no commits yet. A workflow needs a base commit to diff an agent’s work against.',
    })
  }

  if (branch === null) {
    problems.push({
      code: 'detached-head',
      detail: 'HEAD is detached. Check out a branch so changes have somewhere to land.',
    })
  }

  return {
    path: posix(root ?? resolved),
    isRepository: true,
    branch,
    headSha,
    dirty: dirtyPaths.length > 0,
    dirtyPaths: dirtyPaths.slice(0, 20),
    dirtyCount: dirtyPaths.length,
    problems,
  }
}

/**
 * Forward slashes, even on Windows.
 *
 * The stored path is compared against git output, embedded in prompt packets, and
 * shown in the UI. One spelling everywhere avoids a class of "matches in main,
 * fails in the packet" bugs — the same reason `repoPathSchema` refuses a backslash.
 */
function posix(value: string): string {
  return value.split('\\').join('/')
}

/** Fills in the "nothing was readable" shape, so callers get one consistent type. */
function probe({ problems }: { readonly problems: RepositoryProbeProblem[] }): RepositoryProbe {
  return {
    path: '',
    isRepository: false,
    branch: null,
    headSha: null,
    dirty: false,
    dirtyPaths: [],
    dirtyCount: 0,
    problems,
  }
}

/**
 * Finds the repository root above a directory, if there is one.
 *
 * Used to turn "not a repository" into the more useful "you picked a subdirectory of
 * one, here is the root", and to learn git's own spelling of the root. Returns null
 * when the path is genuinely outside any repository.
 */
async function findEnclosingRepository(directory: string): Promise<string | null> {
  try {
    // `rev-parse --show-toplevel` from inside a subdirectory reports the real root;
    // GitService deliberately refuses that case, so this asks git directly.
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd: directory })
    const root = stdout.trim()
    return root === '' ? null : root
  } catch {
    return null
  }
}

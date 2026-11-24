import type { ChangedFile, ChangeType } from '@shared/domain'
import { decodeField } from './exec'

/**
 * Parsers for git's machine-readable formats.
 *
 * These are pure functions over captured output, so the awkward cases — renames,
 * binary files, unicode paths — are testable without constructing a repository for
 * each one. Every shape here was verified against `git 2.51` output rather than
 * recalled; the record layouts are irregular in ways the documentation states but
 * that are easy to get wrong:
 *
 *   --name-status -z   "M" \0 "path"                     2 fields
 *                      "R075" \0 "old" \0 "new"          3 fields for R and C
 *   --numstat -z       "1\t0\tpath"                      1 field, tab-delimited
 *                      "1\t0\t" \0 "old" \0 "new"        3 fields, path empty
 *                      "-\t-\tpath"                      binary: dashes, not numbers
 *
 * Because the field count depends on the status letter, the records cannot be read
 * in fixed-size groups; both parsers consume a variable number per entry.
 */

/**
 * Maps git's status letter to the domain's change type.
 *
 * Copies (`C`) are reported as additions: the new file is genuinely new content
 * from review's point of view, and the domain deliberately has no `copied` case.
 * `T` (type change, e.g. file becomes a symlink) is a modification of the path.
 */
function changeTypeFromLetter(letter: string): ChangeType | null {
  switch (letter) {
    case 'A':
      return 'added'
    case 'M':
    case 'T':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    default:
      return null
  }
}

/** A rename or copy record carries a similarity score, as in `R075`. */
function isRenameOrCopy(code: string): boolean {
  return code.startsWith('R') || code.startsWith('C')
}

interface NameStatusEntry {
  readonly path: string
  readonly changeType: ChangeType
  readonly previousPath: string | null
}

/**
 * Parses `git diff --name-status -z` records.
 *
 * Unknown status letters are skipped rather than guessed at: `U` (unmerged) has no
 * meaning for a changeset captured from a clean step, and inventing a change type
 * for it would put a fabricated entry into review evidence (axiom A2).
 */
export function parseNameStatus(records: readonly string[]): NameStatusEntry[] {
  const entries: NameStatusEntry[] = []

  let index = 0
  while (index < records.length) {
    const code = records[index]
    index += 1
    if (code === undefined) break

    const changeType = changeTypeFromLetter(code.charAt(0))

    if (isRenameOrCopy(code)) {
      const from = records[index]
      const to = records[index + 1]
      index += 2
      if (from === undefined || to === undefined || changeType === null) continue

      entries.push({
        path: decodeField(to),
        changeType,
        previousPath: changeType === 'renamed' ? decodeField(from) : null,
      })
      continue
    }

    const path = records[index]
    index += 1
    if (path === undefined || changeType === null) continue

    entries.push({ path: decodeField(path), changeType, previousPath: null })
  }

  return entries
}

interface NumstatEntry {
  readonly path: string
  readonly insertions: number
  readonly deletions: number
  readonly binary: boolean
}

/**
 * Parses `git diff --numstat -z` records.
 *
 * A binary file reports `-` for both counts. Those become zero rather than an
 * error: the file did change, and `changedFileSchema` requires non-negative
 * integers, so the honest representation is "changed, line counts not meaningful".
 * The `binary` flag is kept so a caller can tell zero-because-binary from
 * zero-because-unchanged instead of inferring it.
 */
export function parseNumstat(records: readonly string[]): NumstatEntry[] {
  const entries: NumstatEntry[] = []

  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (record === undefined) break

    const [rawInsertions, rawDeletions, inlinePath] = record.split('\t')
    if (rawInsertions === undefined || rawDeletions === undefined) continue

    // An empty inline path marks a rename or copy, whose two paths follow as
    // separate records. The new path is the one the change is attributed to.
    let path = inlinePath ?? ''
    if (path === '') {
      const from = records[index]
      const to = records[index + 1]
      index += 2
      if (from === undefined || to === undefined) continue
      path = to
    }

    const binary = rawInsertions === '-' || rawDeletions === '-'

    entries.push({
      path: decodeField(path),
      insertions: binary ? 0 : Number.parseInt(rawInsertions, 10),
      deletions: binary ? 0 : Number.parseInt(rawDeletions, 10),
      binary,
    })
  }

  return entries
}

/** A changed file plus the binary flag, which the domain schema does not carry. */
export interface DiffFile extends ChangedFile {
  readonly binary: boolean
}

/**
 * Joins name-status and numstat output into one entry per file.
 *
 * Two commands are needed because neither format carries both pieces: numstat has
 * no change type and name-status has no line counts. They are joined on the new
 * path, which both report identically for every case including renames.
 *
 * A file present in name-status but missing from numstat keeps zeroed counts
 * rather than being dropped — the change is real evidence even if the counts could
 * not be determined.
 */
export function joinDiffFiles(
  nameStatus: readonly NameStatusEntry[],
  numstat: readonly NumstatEntry[],
): DiffFile[] {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]))

  return nameStatus.map((entry) => {
    const count = counts.get(entry.path)
    return {
      path: entry.path,
      changeType: entry.changeType,
      previousPath: entry.previousPath,
      insertions: count?.insertions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    }
  })
}

/** One entry of `git status --porcelain=v2 -z`. */
export interface StatusEntry {
  readonly path: string
  readonly changeType: ChangeType
  readonly previousPath: string | null
  /** True when the change is staged; a file may be both staged and unstaged. */
  readonly staged: boolean
  readonly unstaged: boolean
}

export interface StatusResult {
  readonly branch: string | null
  /** Null in a repository with no commits yet, where HEAD points nowhere. */
  readonly headSha: string | null
  readonly entries: readonly StatusEntry[]
  readonly untracked: readonly string[]
  readonly ignored: readonly string[]
  readonly conflicted: readonly string[]
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * Format v2 rather than v1 because v1 cannot express a rename unambiguously in
 * `-z` mode and does not report the branch as structured fields. Note that v2
 * reverses the path order of `diff`: a rename entry lists the **new** path inline
 * and the **old** path in the following record.
 */
export function parseStatus(records: readonly string[]): StatusResult {
  let branch: string | null = null
  let headSha: string | null = null
  const entries: StatusEntry[] = []
  const untracked: string[] = []
  const ignored: string[] = []
  const conflicted: string[] = []

  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (record === undefined) break

    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      // Git writes the literal "(detached)" when HEAD is not on a branch.
      branch = value === '(detached)' ? null : decodeField(value)
      continue
    }

    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      // "(initial)" means no commit exists yet, so there is no SHA to report.
      headSha = value === '(initial)' ? null : value
      continue
    }

    if (record.startsWith('# ')) continue

    const kind = record.charAt(0)

    if (kind === '?') {
      untracked.push(decodeField(record.slice(2)))
      continue
    }

    if (kind === '!') {
      ignored.push(decodeField(record.slice(2)))
      continue
    }

    if (kind === 'u') {
      // Unmerged entry: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const fields = record.split(' ')
      const path = fields.slice(10).join(' ')
      if (path !== '') conflicted.push(decodeField(path))
      continue
    }

    if (kind !== '1' && kind !== '2') continue

    // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
    // "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>" then old path
    const fields = record.split(' ')
    const xy = fields[1]
    if (xy === undefined) continue

    const stagedLetter = xy.charAt(0)
    const unstagedLetter = xy.charAt(1)

    const pathFields = kind === '2' ? fields.slice(9) : fields.slice(8)
    const path = pathFields.join(' ')
    if (path === '') continue

    let previousPath: string | null = null
    if (kind === '2') {
      const old = records[index]
      index += 1
      if (old !== undefined) previousPath = decodeField(old)
    }

    // The staged letter takes precedence for the reported type: it describes the
    // change against HEAD, which is what a changeset is diffed against. A '.'
    // means unmodified in that column, so the other column carries the change.
    const letter = stagedLetter === '.' ? unstagedLetter : stagedLetter
    const changeType = changeTypeFromLetter(letter)
    if (changeType === null) continue

    entries.push({
      path: decodeField(path),
      changeType,
      previousPath,
      staged: stagedLetter !== '.',
      unstaged: unstagedLetter !== '.',
    })
  }

  return { branch, headSha, entries, untracked, ignored, conflicted }
}

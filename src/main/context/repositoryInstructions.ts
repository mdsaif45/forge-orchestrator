import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reads a repository's own agent instructions, if it has any.
 *
 * Forge reads this file and decides to include it, rather than letting the CLI load it:
 * the spawned process runs with `--safe-mode` precisely so that what enters an agent's
 * context is what Forge put there (A1). Passing the contents through the packet keeps
 * that guarantee while restoring the convention — and makes the text part of the
 * artifact stored per step, so what the agent was told can be read back later.
 *
 * ```
 * present   -> contents, capped and redacted downstream by the context engine
 * absent    -> null, which is the common case and not a warning
 * unreadable-> null; a permission error here must not fail a workflow that
 *              would otherwise run fine without the file
 * ```
 */
export async function readRepositoryInstructions(
  repositoryPath: string,
  filenames: readonly string[],
): Promise<string | null> {
  // The names come from the runtime rather than from a constant here: which file a
  // provider's CLI reads is provider-specific, and core must not contain a provider name
  // (A6). The first that exists wins, so a repository carrying several is unambiguous.
  for (const filename of filenames) {
    try {
      const contents = await readFile(join(repositoryPath, filename), 'utf8')
      if (contents.trim() !== '') return contents
    } catch {
      // Deliberately broad, and deliberately a `continue`. ENOENT is the normal case, and
      // the others — a directory in its place, a permission error, a decoding failure —
      // are all equally "nothing usable here", none of which is a reason to stop a run or
      // to skip the remaining candidates.
      continue
    }
  }

  return null
}

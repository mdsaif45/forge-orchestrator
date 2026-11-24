/**
 * Removal of a temporary directory that a child process may still be holding.
 *
 * Windows keeps a lock on a directory until every process using it has fully
 * exited, so a delete issued the moment after `kill` fails with EBUSY. Three
 * test files hit this independently — a killed pty, a killed build command, and
 * git's own short-lived child processes — so the retry lives here rather than
 * being pasted a fourth time.
 *
 * Polled rather than slept: the bound means a directory that genuinely cannot be
 * removed still fails the test, while a normal run clears on the first attempt.
 * A fixed sleep would instead encode one machine's timing into the suite.
 */
import { rmSync } from 'node:fs'

const ATTEMPTS = 50
const DELAY_MS = 40

export async function removeTempDir(directory: string): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  // The final attempt is deliberately unguarded: if the directory is still
  // locked after the full window, that is a real failure and the test should say
  // so rather than pass on a swallowed error.
  rmSync(directory, { recursive: true, force: true })
}

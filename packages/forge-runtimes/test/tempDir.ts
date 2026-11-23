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

  rmSync(directory, { recursive: true, force: true })
}

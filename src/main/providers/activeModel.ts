import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Which provider and model the native agent uses, readable from main.
 *
 * The renderer keeps its provider list in `localStorage`, which main cannot
 * read — so a workflow, which runs entirely in main, had no way to know what to
 * call. Rather than hardcode a default and pretend it was configuration, the
 * renderer publishes its choice here and main reads it back.
 *
 * A file rather than a database row: this is a single user preference with no
 * history worth keeping, and the event log is for project truth (A1). It is
 * written on change and read at the start of each turn, so switching model
 * between turns takes effect without a restart.
 */

export interface ActiveModel {
  readonly providerId: string
  readonly model: string
  readonly endpointUrl?: string | undefined
  readonly apiKey?: string | undefined
}

/**
 * Where the choice lands when nothing has been configured.
 *
 * A local Ollama on its documented port, because that is the setup with no key
 * to enter and nothing to sign up for. If it is not running, the turn fails
 * naming the endpoint it tried — which is a better first experience than a
 * silent fallback to a provider the user never chose.
 */
const FALLBACK: ActiveModel = {
  providerId: 'ollama',
  model: 'llama3.2',
  endpointUrl: 'http://localhost:11434',
}

export class ActiveModelStore {
  constructor(private readonly file: string) {}

  read(): ActiveModel {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof raw !== 'object' || raw === null) return FALLBACK

      const candidate = raw as Partial<ActiveModel>
      // A stored value missing either half is unusable, and falling back is
      // more honest than sending an empty model name to a provider.
      if (typeof candidate.providerId !== 'string' || candidate.providerId === '') return FALLBACK
      if (typeof candidate.model !== 'string' || candidate.model === '') return FALLBACK

      return {
        providerId: candidate.providerId,
        model: candidate.model,
        ...(typeof candidate.endpointUrl === 'string'
          ? { endpointUrl: candidate.endpointUrl }
          : {}),
        ...(typeof candidate.apiKey === 'string' ? { apiKey: candidate.apiKey } : {}),
      }
    } catch {
      // Absent or unreadable: the fallback, not a thrown startup failure.
      return FALLBACK
    }
  }

  write(model: ActiveModel): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(model, null, 2), 'utf8')
  }
}

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

export class ActiveModelStore {
  constructor(private readonly file: string) {}

  /**
   * The configured choice, or null when there is none.
   *
   * Null rather than a default model name. The first version named
   * `llama3.2` on a local Ollama, on the reasoning that it is the setup with
   * nothing to sign up for — and then the machine it was written on turned out
   * not to have that model pulled at all. A guessed default does not fail as
   * "nothing is configured"; it fails as "model not found" against a model the
   * user never chose, which sends whoever reads that error looking in the
   * wrong place.
   *
   * The endpoint has a real default because a provider id fixes it, but which
   * model to run is a choice only the user can make.
   */
  read(): ActiveModel | null {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // Absent or unreadable: nothing configured, not a startup failure.
      return null
    }

    if (typeof raw !== 'object' || raw === null) return null

    const candidate = raw as Partial<ActiveModel>
    // Missing either half is unusable; saying so beats sending an empty model
    // name to a provider and reporting whatever it says back.
    if (typeof candidate.providerId !== 'string' || candidate.providerId === '') return null
    if (typeof candidate.model !== 'string' || candidate.model === '') return null

    return {
      providerId: candidate.providerId,
      model: candidate.model,
      ...(typeof candidate.endpointUrl === 'string' ? { endpointUrl: candidate.endpointUrl } : {}),
      ...(typeof candidate.apiKey === 'string' ? { apiKey: candidate.apiKey } : {}),
    }
  }

  write(model: ActiveModel): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(model, null, 2), 'utf8')
  }
}

/**
 * Resolves an active model from explicit options, stored model, or environment variables.
 */
export function resolveEffectiveModel(
  stored: ActiveModel | null,
  override?: {
    readonly providerId?: string | undefined
    readonly model?: string | undefined
    readonly endpointUrl?: string | undefined
    readonly apiKey?: string | undefined
  },
): ActiveModel {
  if (override?.model !== undefined && override.model.trim() !== '') {
    return {
      providerId: override.providerId ?? 'ollama',
      model: override.model,
      ...(override.endpointUrl !== undefined && override.endpointUrl !== ''
        ? { endpointUrl: override.endpointUrl }
        : {}),
      ...(override.apiKey !== undefined && override.apiKey !== ''
        ? { apiKey: override.apiKey }
        : {}),
    }
  }

  if (stored !== null && stored.model !== '') {
    return stored
  }

  if (process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY.trim() !== '') {
    return {
      providerId: 'openai',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      apiKey: process.env.OPENAI_API_KEY,
    }
  }

  if (
    process.env.OPENROUTER_API_KEY !== undefined &&
    process.env.OPENROUTER_API_KEY.trim() !== ''
  ) {
    return {
      providerId: 'openrouter',
      model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o',
      apiKey: process.env.OPENROUTER_API_KEY,
    }
  }

  return {
    providerId: 'ollama',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
  }
}

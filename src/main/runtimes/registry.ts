import {
  canHoldRole,
  missingCapabilities,
  type Capability,
  type IAgentRuntime,
  type Role,
  type RuntimeId,
} from '@shared/domain'

/**
 * The runtime registry.
 *
 * The application layer resolves runtimes through this and never constructs one, which
 * is what keeps provider names out of core (A6). `src/main/runtimes/*` is the only
 * directory allowed to name a provider; an ESLint boundary rule enforces it rather
 * than leaving it to review.
 *
 * Deliberately not a module-level singleton: a test needs its own registry with only a
 * mock in it, and a global would leak registrations between tests. `main/index.ts`
 * owns the one the app uses.
 */

/** Raised when a runtime id is not registered. */
export class UnknownRuntimeError extends Error {
  constructor(
    readonly runtimeId: string,
    available: readonly string[],
  ) {
    super(
      `No runtime registered as "${runtimeId}". Registered: ${
        available.length === 0 ? '(none)' : available.join(', ')
      }`,
    )
    this.name = 'UnknownRuntimeError'
  }
}

/**
 * Raised when a runtime is asked to hold a role it cannot perform.
 *
 * Names the missing capabilities, because "cannot hold role" alone leaves the user
 * guessing which permission or feature is absent.
 */
export class IncapableRuntimeError extends Error {
  constructor(
    readonly runtimeId: string,
    readonly role: Role,
    readonly missing: readonly Capability[],
  ) {
    super(`Runtime "${runtimeId}" cannot hold role "${role}": missing ${missing.join(', ')}`)
    this.name = 'IncapableRuntimeError'
  }
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, IAgentRuntime>()

  /**
   * Registers a runtime.
   *
   * Re-registering the same id is refused rather than silently overwriting: two
   * adapters answering to one id would make which one runs depend on registration
   * order, and that is the kind of ambiguity that surfaces as an unreproducible bug.
   */
  register(runtime: IAgentRuntime): void {
    if (this.runtimes.has(runtime.id)) {
      throw new Error(`A runtime is already registered as "${runtime.id}"`)
    }

    this.runtimes.set(runtime.id, runtime)
  }

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId)
  }

  /** Every registered runtime, in registration order. */
  list(): readonly IAgentRuntime[] {
    return [...this.runtimes.values()]
  }

  ids(): readonly RuntimeId[] {
    return this.list().map((runtime) => runtime.id)
  }

  /** Resolves by id, throwing rather than returning null: a missing runtime is a bug. */
  resolve(runtimeId: string): IAgentRuntime {
    const runtime = this.runtimes.get(runtimeId)
    if (runtime === undefined) {
      throw new UnknownRuntimeError(runtimeId, [...this.runtimes.keys()])
    }

    return runtime
  }

  /**
   * Resolves a runtime and checks it can perform the role before returning it.
   *
   * The check happens at binding time, not at step time. A read-only runtime bound as
   * the implementer would otherwise fail only once a workflow was already running,
   * with a half-finished task to clean up.
   */
  resolveForRole(runtimeId: string, role: Role): IAgentRuntime {
    const runtime = this.resolve(runtimeId)

    if (!canHoldRole(runtime.capabilities, role)) {
      throw new IncapableRuntimeError(
        runtimeId,
        role,
        missingCapabilities(runtime.capabilities, role),
      )
    }

    return runtime
  }

  /**
   * Every runtime able to hold a role.
   *
   * Used by the settings UI to offer only valid bindings, so an impossible pairing is
   * unselectable rather than rejected after the fact.
   */
  candidatesForRole(role: Role): readonly IAgentRuntime[] {
    return this.list().filter((runtime) => canHoldRole(runtime.capabilities, role))
  }
}

/**
 * The CLI a runtime is driven through, for the enrolment flow.
 *
 * Kept beside the registry rather than in the adapters because it answers a different
 * question: an adapter knows how to *run* its CLI, while enrolment needs to name the
 * executable a user signs into before any session exists. Unknown runtimes fall back
 * to their own id, which fails visibly at spawn rather than silently doing nothing.
 */
export function runtimeExecutable(runtimeId: string): string {
  const KNOWN: Record<string, string> = {
    'claude-cli': 'claude',
    'antigravity-cli': 'agy',
  }

  return KNOWN[runtimeId] ?? runtimeId
}

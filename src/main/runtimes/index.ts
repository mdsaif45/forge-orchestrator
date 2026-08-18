/**
 * Agent runtimes.
 *
 * **The only directory allowed to name a provider.** Everything above talks to
 * `IAgentRuntime` and resolves through `RuntimeRegistry`, which is what axiom A6
 * buys: the #20 spike found Antigravity ships no headless CLI, and that became a
 * scoping decision rather than a rewrite.
 *
 * Enforced by an ESLint boundary rule, not by convention — see `eslint.config.js`.
 */

export { IncapableRuntimeError, RuntimeRegistry, UnknownRuntimeError } from './registry'

export { exchange, type ExchangeOutcome } from './exchange'

export { MockAgentRuntime, type MockRuntimeOptions } from './mockRuntime'

export {
  SCENARIOS,
  scenarioSchema,
  type Scenario,
  type ScenarioFileEdit,
  type ScenarioName,
  type ScenarioStep,
} from './scenario'

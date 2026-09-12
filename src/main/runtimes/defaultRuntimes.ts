import { join } from 'node:path'
import type { ProcessManager } from '../process'
import type { RuntimeRegistry } from './registry'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { HostedClaudeRuntime } from './hostedClaudeRuntime'
import { GenericCliAgentRuntime } from './genericCliRuntime'
import {
  setCustomCliStorePath,
  setAgentDefaultsStorePath,
  loadCustomClis,
  STANDARD_AGENT_CATALOG,
} from './cliDetector'
import type { ActiveModel, ActiveModelStore } from '../providers/activeModel'

export interface DefaultRuntimesOptions {
  readonly processes: ProcessManager
  readonly dataDir: string
  readonly activeModel: ActiveModelStore
  readonly resolveActiveModel?: (() => ActiveModel | null) | undefined
}

/**
 * Registers standard agent runtimes in the registry.
 *
 * Placed in src/main/runtimes so concrete runtime adapters and provider
 * names remain confined to the runtime layer per Axiom A6.
 */
export function registerDefaultRuntimes(
  registry: RuntimeRegistry,
  options: DefaultRuntimesOptions,
): void {
  // Forge's own agent: the model plus Forge's tool loop, no CLI in between.
  registry.register(
    new NativeAgentRuntime({
      resolveModel: () =>
        options.resolveActiveModel ? options.resolveActiveModel() : options.activeModel.read(),
    }),
  )

  // Hosted Claude Code CLI runtime
  registry.register(
    new HostedClaudeRuntime({
      processes: options.processes,
      hookReceiverDir: join(options.dataDir, 'hooks'),
    }),
  )

  setCustomCliStorePath(join(options.dataDir, 'custom-clis.json'))
  setAgentDefaultsStorePath(join(options.dataDir, 'agent-defaults.json'))

  // Register all standard CLI agents from the catalog (OpenCode, Codex, etc.)
  for (const agent of STANDARD_AGENT_CATALOG) {
    if (!registry.has(agent.id)) {
      registry.register(
        new GenericCliAgentRuntime({
          id: agent.id,
          name: agent.name,
          executable: agent.executable,
          processes: options.processes,
        }),
      )
    }
  }

  // Register user-configured custom CLIs
  for (const customCli of loadCustomClis()) {
    if (!registry.has(customCli.id)) {
      registry.register(
        new GenericCliAgentRuntime({
          id: customCli.id,
          name: customCli.name,
          executable: customCli.executable,
          defaultArgs: customCli.defaultArgs,
          processes: options.processes,
        }),
      )
    }
  }
}

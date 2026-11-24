import { join } from 'node:path'
import {
  type ProcessManager,
  type RuntimeRegistry,
  HostedClaudeRuntime,
  HostedAntigravityRuntime,
  GenericCliAgentRuntime,
  CustomCliRuntime,
  setCustomCliStorePath,
  setAgentDefaultsStorePath,
  loadCustomClis,
  STANDARD_AGENT_CATALOG,
} from '@forge/runtimes'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import type { ActiveModel, ActiveModelStore } from '../providers/activeModel'
import type { CustomRuntimeConfig } from '../config/forgeConfig'

export interface DefaultRuntimesOptions {
  readonly processes: ProcessManager
  readonly dataDir: string
  readonly activeModel: ActiveModelStore
  readonly resolveActiveModel?: (() => ActiveModel | null) | undefined
  readonly customRuntimes?: readonly CustomRuntimeConfig[] | undefined
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

  // Hosted Antigravity CLI runtime (#168)
  registry.register(
    new HostedAntigravityRuntime({
      processes: options.processes,
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

  // Register user-configured custom CLIs from storage
  for (const customCli of loadCustomClis()) {
    if (!registry.has(customCli.id)) {
      registry.register(
        new CustomCliRuntime({
          id: customCli.id,
          name: customCli.name,
          command: customCli.executable,
          argsTemplate: customCli.defaultArgs,
        }),
      )
    }
  }

  // Register custom CLIs from .forgerc configuration
  if (options.customRuntimes) {
    for (const customCfg of options.customRuntimes) {
      if (!registry.has(customCfg.id)) {
        registry.register(
          new CustomCliRuntime({
            id: customCfg.id,
            name: customCfg.name,
            command: customCfg.command,
            argsTemplate: customCfg.argsTemplate,
            env: customCfg.env,
            capabilities: customCfg.capabilities,
            instructionFilenames: customCfg.instructionFilenames,
          }),
        )
      }
    }
  }
}

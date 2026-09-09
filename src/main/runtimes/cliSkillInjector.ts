import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowArtifact } from '@shared/domain'

export interface CliInjectionParams {
  readonly agentExecutable: string
  readonly workspacePath: string
  readonly systemPrompt?: string | undefined
  readonly skills?: readonly string[] | undefined
  readonly incomingArtifacts?: readonly WorkflowArtifact[] | undefined
  readonly objective?: string | undefined
}

export interface PreparedCliInvocation {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
}

/**
 * Materializes upstream workflow artifacts, skillsets, and rules into the workspace
 * so any installed CLI agent (claude, opencode, codex, agy, aider) can read them
 * and execute with full context.
 */
export async function injectSkillsAndPrepareCli({
  agentExecutable,
  workspacePath,
  systemPrompt,
  skills = [],
  incomingArtifacts = [],
  objective = 'Execute workflow task',
}: CliInjectionParams): Promise<PreparedCliInvocation> {
  const forgeDir = join(workspacePath, '.forge')
  const artifactsDir = join(forgeDir, 'artifacts')
  const skillsDir = join(forgeDir, 'skills')

  await mkdir(artifactsDir, { recursive: true })
  await mkdir(skillsDir, { recursive: true })

  // 1. Materialize incoming artifacts to disk
  const artifactSummaries: string[] = []
  for (const artifact of incomingArtifacts) {
    const safeName = `${artifact.kind.replace(/[^a-zA-Z0-9_-]+/g, '_')}.${
      artifact.format === 'diff' ? 'patch' : artifact.format === 'json' ? 'json' : 'md'
    }`
    const targetPath = join(artifactsDir, safeName)
    await writeFile(targetPath, artifact.content, 'utf8')
    artifactSummaries.push(
      `- **${artifact.title}** (kind: \`${artifact.kind}\`): Available at \`.forge/artifacts/${safeName}\``,
    )
  }

  // 2. Prepare skill instructions
  const skillInstructions: string[] = []
  for (const skill of skills) {
    skillInstructions.push(`- Skill active: **${skill}**`)
  }

  // 3. Write instructions / context file
  const instructionsMarkdown = [
    `# Forge Orchestrator: Mission Context`,
    ``,
    `## Objective`,
    objective,
    ``,
    systemPrompt ? `## Node Instructions\n${systemPrompt}\n` : '',
    artifactSummaries.length > 0
      ? `## Upstream Deliverables & Inputs\n${artifactSummaries.join('\n')}\n`
      : '',
    skillInstructions.length > 0 ? `## Active Forge Skills\n${skillInstructions.join('\n')}\n` : '',
    `## Working Rules`,
    `- Forge Axiom A1: Forge owns ground truth. Verify your work using tests and builds.`,
    `- Forge Axiom A7: Least privilege. Modify only files strictly relevant to the objective.`,
  ]
    .filter(Boolean)
    .join('\n')

  await writeFile(join(forgeDir, 'instructions.md'), instructionsMarkdown, 'utf8')

  // 4. Also write CLAUDE.md / AGENTS.md for CLI agents that auto-read root guidelines
  await writeFile(join(workspacePath, 'CLAUDE.md'), instructionsMarkdown, 'utf8')

  // 5. Compose CLI invocation
  const args: string[] = []
  const initialPrompt = [
    `Objective: ${objective}.`,
    artifactSummaries.length > 0
      ? `Read upstream inputs in .forge/artifacts/ before starting.`
      : '',
    systemPrompt ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    executable: agentExecutable,
    args,
    cwd: workspacePath,
    env: {
      ...process.env,
      FORGE_WORKFLOW_WORKSPACE: workspacePath,
      FORGE_AGENT_EXECUTABLE: agentExecutable,
    },
    prompt: initialPrompt,
  }
}

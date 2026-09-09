import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { injectSkillsAndPrepareCli } from './cliSkillInjector'

describe('cliSkillInjector', () => {
  it('injects skills, writes upstream artifacts to disk, and configures CLI invocation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-cli-test-'))
    try {
      const prepared = await injectSkillsAndPrepareCli({
        agentExecutable: 'claude',
        workspacePath: tempDir,
        systemPrompt: 'Follow strict architectural guidelines.',
        skills: ['ast-editing', 'code-review'],
        objective: 'Implement user auth module',
        incomingArtifacts: [
          {
            id: 'art-1',
            workflowId: 'wf-test',
            nodeId: 'node-spec',
            kind: 'final_specification',
            format: 'markdown',
            title: 'Auth Spec',
            content: '# User Authentication Spec\n\nOAuth2 and session cookies.',
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ],
      })

      expect(prepared.executable).toBe('claude')
      expect(prepared.cwd).toBe(tempDir)
      expect(prepared.prompt).toContain('Implement user auth module')
      expect(prepared.prompt).toContain('.forge/artifacts/')

      // Verify artifact on disk
      const artifactContent = await readFile(
        join(tempDir, '.forge', 'artifacts', 'final_specification.md'),
        'utf8',
      )
      expect(artifactContent).toBe('# User Authentication Spec\n\nOAuth2 and session cookies.')

      // Verify CLAUDE.md / instructions.md
      const claudeMd = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
      expect(claudeMd).toContain('Implement user auth module')
      expect(claudeMd).toContain('ast-editing')
      expect(claudeMd).toContain('code-review')
      expect(claudeMd).toContain('Auth Spec')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

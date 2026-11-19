import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkflowTemplateV2 } from '@shared/domain'
import { DEFAULT_TEMPLATES_V2 } from './defaultTemplatesV2'
import { TemplateV2Store } from './templateV2Store'
import {
  discoverCustomTemplates,
  registerCustomTemplates,
  validateCustomTemplateFile,
} from './customTemplateLoader'

describe('customTemplateLoader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-template-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  const sampleTemplate: WorkflowTemplateV2 = {
    ...DEFAULT_TEMPLATES_V2[0]!,
    id: 'custom-sdlc',
    name: 'Custom SDLC Template',
  }

  it('validates and parses a valid custom template file', async () => {
    const filePath = join(tempDir, 'custom.json')
    await writeFile(filePath, JSON.stringify(sampleTemplate, null, 2), 'utf8')

    const res = await validateCustomTemplateFile(filePath)
    expect(res.valid).toBe(true)
    expect(res.template?.id).toBe('custom-sdlc')
    expect(res.template?.name).toBe('Custom SDLC Template')
    expect(res.errors).toHaveLength(0)
  })

  it('fails closed when template file does not exist', async () => {
    const res = await validateCustomTemplateFile(join(tempDir, 'missing.json'))
    expect(res.valid).toBe(false)
    expect(res.errors[0]).toContain('Template file not found')
  })

  it('fails closed on invalid JSON syntax', async () => {
    const filePath = join(tempDir, 'invalid.json')
    await writeFile(filePath, '{ not valid json', 'utf8')

    const res = await validateCustomTemplateFile(filePath)
    expect(res.valid).toBe(false)
    expect(res.errors[0]).toContain('Template JSON syntax error')
  })

  it('fails closed when template violates schema or DAG topology', async () => {
    const invalidTemplate = {
      id: 'bad-template',
      nodes: [], // Missing required fields
    }

    const filePath = join(tempDir, 'bad.json')
    await writeFile(filePath, JSON.stringify(invalidTemplate), 'utf8')

    const res = await validateCustomTemplateFile(filePath)
    expect(res.valid).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it('discovers custom templates and registers them into TemplateV2Store', async () => {
    const validPath = join(tempDir, 'custom.json')
    await writeFile(validPath, JSON.stringify(sampleTemplate), 'utf8')

    // Write a non-json file to ensure it is ignored
    await writeFile(join(tempDir, 'notes.txt'), 'Not a template', 'utf8')

    // Write an invalid json file to ensure error tracking
    await writeFile(join(tempDir, 'broken.json'), '{"invalid": true}', 'utf8')

    const discovery = await discoverCustomTemplates([tempDir])
    expect(discovery.templates).toHaveLength(1)
    expect(discovery.templates[0]?.id).toBe('custom-sdlc')
    expect(discovery.errors).toHaveLength(1)
    expect(discovery.errors[0]?.path).toContain('broken.json')

    const store = new TemplateV2Store([])
    const registeredCount = await registerCustomTemplates(store, [tempDir])
    expect(registeredCount).toBe(1)
    expect(store.get('custom-sdlc')).toBeDefined()
  })
})

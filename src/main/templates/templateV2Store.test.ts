import { describe, expect, it } from 'vitest'
import type { WorkflowTemplateV2 } from '@shared/domain'
import { TemplateV2Store, createDefaultTemplateResolver } from './templateV2Store'

describe('TemplateV2Store and createDefaultTemplateResolver', () => {
  it('loads default V2 templates on construction', () => {
    const store = new TemplateV2Store()
    const list = store.list()
    expect(list.length).toBeGreaterThan(0)
    expect(store.get('cr-sdlc')).not.toBeNull()
  })

  it('filters templates by status', () => {
    const store = new TemplateV2Store()
    const published = store.list('published')
    expect(published.every((t) => t.status === 'published')).toBe(true)
  })

  it('saves, retrieves, and deletes custom V2 templates', () => {
    const store = new TemplateV2Store()
    const customTemplate: WorkflowTemplateV2 = {
      id: 'custom-v2-test',
      name: 'Custom V2 Test',
      version: 1,
      status: 'draft',
      category: 'testing',
      description: 'A test custom template',
      createdAt: '2026-10-19T12:00:00.000Z',
      updatedAt: '2026-10-19T12:00:00.000Z',
      nodes: [
        {
          id: 'gate-node',
          title: 'Approval Gate',
          type: 'user_gate',
          runtimeType: 'human',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [],
    }

    store.save(customTemplate)
    expect(store.get('custom-v2-test')).toEqual(customTemplate)

    expect(store.delete('custom-v2-test')).toBe(true)
    expect(store.get('custom-v2-test')).toBeNull()
  })

  describe('createDefaultTemplateResolver', () => {
    const resolver = createDefaultTemplateResolver()

    it('resolves published V2 templates from TemplateV2Store', () => {
      const crSdlc = resolver('cr-sdlc')
      expect(crSdlc).not.toBeNull()
      expect(crSdlc?.id).toBe('cr-sdlc')
      expect(crSdlc?.nodes.length).toBeGreaterThan(0)
    })

    it('resolves linear templates by raw template ID', () => {
      const feature = resolver('feature')
      expect(feature).not.toBeNull()
      expect(feature?.id).toBe('compiled-feature')
      const userGate = feature?.nodes.find((n) => n.id === 'step-2-user')
      expect(userGate?.type).toBe('user_gate')
    })

    it('resolves linear templates by compiled-prefixed template ID', () => {
      const compiledFeature = resolver('compiled-feature')
      expect(compiledFeature).not.toBeNull()
      expect(compiledFeature?.id).toBe('compiled-feature')
      const userGate = compiledFeature?.nodes.find((n) => n.id === 'step-2-user')
      expect(userGate?.type).toBe('user_gate')

      const compiledBugfix = resolver('compiled-bugfix')
      expect(compiledBugfix).not.toBeNull()
      expect(compiledBugfix?.id).toBe('compiled-bugfix')
    })

    it('fails closed and returns null for unknown or mismatched template IDs', () => {
      expect(resolver('non-existent-template')).toBeNull()
      expect(resolver('compiled-non-existent')).toBeNull()
      expect(resolver('')).toBeNull()
    })
  })
})

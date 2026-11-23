import { describe, expect, it } from 'vitest'
import {
  BUG_FIX,
  exportTemplateJson,
  FEATURE_IMPLEMENTATION,
  importTemplateJson,
  REFACTOR,
  SECURITY_AUDIT,
  TEMPLATES,
  TEST_COVERAGE,
  validateTemplate,
  type WorkflowTemplate,
} from './template'

describe('Workflow Templates as Data (#45)', () => {
  it('validates all built-in templates without problems', () => {
    const builtIns: readonly WorkflowTemplate[] = [
      FEATURE_IMPLEMENTATION,
      BUG_FIX,
      REFACTOR,
      SECURITY_AUDIT,
      TEST_COVERAGE,
    ]

    for (const template of builtIns) {
      const problems = validateTemplate(template)
      expect(problems).toEqual([])
      expect(template.steps.length).toBeGreaterThanOrEqual(4)
      expect(TEMPLATES[template.id as keyof typeof TEMPLATES]).toBeDefined()
    }
  })

  it('rejects a template with mismatched performedByForge flag', () => {
    const broken: WorkflowTemplate = {
      id: 'broken-forge-flag',
      name: 'Broken Flag Template',
      description: 'Test template with wrong performedByForge flag',
      steps: [
        {
          role: 'planner',
          label: 'Plan',
          advanceTrigger: 'planProduced',
          performedByForge: true, // Should be false for planner
        },
      ],
    }

    const problems = validateTemplate(broken)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]?.detail).toContain('performedByForge to false')
  })

  it('rejects a template with missing id, name, or empty steps', () => {
    const emptySteps: WorkflowTemplate = {
      id: 'empty',
      name: 'Empty Steps',
      description: 'No steps',
      steps: [],
    }

    const problems = validateTemplate(emptySteps)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]?.detail).toContain('at least one step')
  })

  it('exports and imports a template cleanly as JSON', () => {
    const json = exportTemplateJson(SECURITY_AUDIT)
    expect(typeof json).toBe('string')

    const imported = importTemplateJson(json)
    expect(imported.problems).toEqual([])
    expect(imported.template).toEqual(SECURITY_AUDIT)
  })

  it('rejects malformed or invalid JSON during template import', () => {
    const malformed = importTemplateJson('{ invalid json text }')
    expect(importedNull(malformed.template)).toBe(true)
    expect(malformed.problems.length).toBeGreaterThan(0)
    expect(malformed.problems[0]?.detail).toContain('Invalid JSON')

    const invalidStructure = importTemplateJson(
      JSON.stringify({
        id: 'bad',
        // missing name and steps
      }),
    )
    expect(invalidStructure.template).toBeNull()
    expect(invalidStructure.problems.length).toBeGreaterThan(0)
  })
})

function importedNull(val: unknown): val is null {
  return val === null
}

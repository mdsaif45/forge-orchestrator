import { z } from 'zod'
import { roleSchema } from './enums'
import { workflowTriggerSchema } from './transitions'

/**
 * Workflow templates, as data.
 *
 * ```
 * "Feature Implementation"
 *   1  planner        ──> binding resolves ──> some runtime
 *   2  user           ──> approval gate, no runtime
 *   3  implementer    ──> binding resolves ──> some runtime
 *   4  system         ──> Forge verifies: build, test, diff scope
 *   5  reviewer       ──> binding resolves ──> some runtime
 * ```
 *
 * A template names **roles**, never runtimes. Which runtime occupies a role is a binding,
 * resolved per project at run time — that is what makes "swap the planner and the
 * implementer" a configuration change rather than a code change (A6).
 */

/** One step of a template. Concrete steps are instantiated from these per run. */
export const templateStepSchema = z.strictObject({
  role: roleSchema,
  /** Shown in the workflow graph, so a user reads intent rather than a role name. */
  label: z.string().min(1),
  /**
   * What advancing past this step means for the state machine.
   *
   * Naming the trigger here rather than inferring it from the role keeps the template
   * honest about the machine it drives: a step whose trigger is not legal from the state it
   * runs in is a broken template, and that is checkable (see `validateTemplate`).
   */
  advanceTrigger: workflowTriggerSchema,
  /**
   * Whether Forge performs this step itself.
   *
   * `system` steps produce evidence — a build, a test run, a diff — and `user` steps are
   * gates. Neither resolves a binding, which is why a template can contain roles no runtime
   * could ever hold.
   */
  performedByForge: z.boolean(),
})

export type TemplateStep = z.infer<typeof templateStepSchema>

export const workflowTemplateSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(templateStepSchema).min(1).readonly(),
})

export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>

/**
 * 1. Feature Implementation Template
 * Plan, approve, implement, verify, review — with a bounded correction loop.
 */
export const FEATURE_IMPLEMENTATION: WorkflowTemplate = workflowTemplateSchema.parse({
  id: 'feature',
  name: 'Feature Implementation',
  description: 'Plan, approve, implement, verify, review — with a bounded correction loop',
  steps: [
    {
      role: 'planner',
      label: 'Plan the change',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      role: 'user',
      label: 'Approve the plan',
      advanceTrigger: 'userApproved',
      performedByForge: true,
    },
    {
      role: 'implementer',
      label: 'Implement',
      advanceTrigger: 'implemented',
      performedByForge: false,
    },
    {
      role: 'system',
      label: 'Verify: build, tests, diff scope',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      role: 'reviewer',
      label: 'Review the change',
      advanceTrigger: 'reviewPassed',
      performedByForge: false,
    },
  ],
})

/**
 * 2. Bug Fix Template
 * Investigate root cause, approve fix approach, implement fix & regression test, verify, review.
 */
export const BUG_FIX: WorkflowTemplate = workflowTemplateSchema.parse({
  id: 'bugfix',
  name: 'Bug Fix',
  description:
    'Investigate root cause, propose fix, implement regression tests, verify, and review',
  steps: [
    {
      role: 'planner',
      label: 'Investigate root cause and propose fix',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      role: 'user',
      label: 'Approve bug fix strategy',
      advanceTrigger: 'userApproved',
      performedByForge: true,
    },
    {
      role: 'implementer',
      label: 'Fix bug and add regression tests',
      advanceTrigger: 'implemented',
      performedByForge: false,
    },
    {
      role: 'system',
      label: 'Verify: regression test suite and build',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      role: 'reviewer',
      label: 'Review bug fix and edge case coverage',
      advanceTrigger: 'reviewPassed',
      performedByForge: false,
    },
  ],
})

/**
 * 3. Refactor Template
 * Plan structural refactoring, preserve external behavior, verify test suite, and review.
 */
export const REFACTOR: WorkflowTemplate = workflowTemplateSchema.parse({
  id: 'refactor',
  name: 'Refactor',
  description:
    'Plan structural cleanup, execute refactor preserving behavior, verify tests, and review',
  steps: [
    {
      role: 'planner',
      label: 'Analyze code structure and plan refactor',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      role: 'user',
      label: 'Approve refactoring plan',
      advanceTrigger: 'userApproved',
      performedByForge: true,
    },
    {
      role: 'implementer',
      label: 'Execute refactor without behavioral changes',
      advanceTrigger: 'implemented',
      performedByForge: false,
    },
    {
      role: 'system',
      label: 'Verify: full test suite and diff scope',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      role: 'reviewer',
      label: 'Audit refactor for behavioral regressions',
      advanceTrigger: 'reviewPassed',
      performedByForge: false,
    },
  ],
})

/**
 * 4. Security Audit & Hardening Template
 * Audit vulnerabilities, approve remediation, apply hardening patches, re-test, and review.
 */
export const SECURITY_AUDIT: WorkflowTemplate = workflowTemplateSchema.parse({
  id: 'security',
  name: 'Security Audit & Hardening',
  description: 'Audit attack surfaces, patch vulnerabilities, run security tests, and review',
  steps: [
    {
      role: 'planner',
      label: 'Audit security vulnerabilities and attack surfaces',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      role: 'user',
      label: 'Approve security remediation plan',
      advanceTrigger: 'userApproved',
      performedByForge: true,
    },
    {
      role: 'implementer',
      label: 'Apply security patches and hardening',
      advanceTrigger: 'implemented',
      performedByForge: false,
    },
    {
      role: 'system',
      label: 'Verify: security tests, build, and diff',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      role: 'reviewer',
      label: 'Security audit and compliance review',
      advanceTrigger: 'reviewPassed',
      performedByForge: false,
    },
  ],
})

/**
 * 5. Test Coverage Expansion Template
 * Identify untested paths, approve testing plan, write tests, execute test suite, and review.
 */
export const TEST_COVERAGE: WorkflowTemplate = workflowTemplateSchema.parse({
  id: 'test-coverage',
  name: 'Test Coverage Expansion',
  description: 'Identify coverage gaps, write unit & integration tests, verify suite, and review',
  steps: [
    {
      role: 'planner',
      label: 'Analyze test coverage gaps and edge cases',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      role: 'user',
      label: 'Approve test coverage strategy',
      advanceTrigger: 'userApproved',
      performedByForge: true,
    },
    {
      role: 'implementer',
      label: 'Write unit and integration tests',
      advanceTrigger: 'implemented',
      performedByForge: false,
    },
    {
      role: 'system',
      label: 'Run test suite and verify test execution',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      role: 'reviewer',
      label: 'Review test assertions and coverage',
      advanceTrigger: 'reviewPassed',
      performedByForge: false,
    },
  ],
})

export const TEMPLATES = {
  feature: FEATURE_IMPLEMENTATION,
  bugfix: BUG_FIX,
  refactor: REFACTOR,
  security: SECURITY_AUDIT,
  'test-coverage': TEST_COVERAGE,
} as const satisfies Record<string, WorkflowTemplate>

export type TemplateId = keyof typeof TEMPLATES

/** A template that could not be run, and why. */
export interface TemplateProblem {
  readonly stepIndex: number
  readonly detail: string
}

/**
 * Checks a template against the state machine and structural constraints.
 *
 * A template is a claim about a path through the machine, and a claim that does not hold
 * produces a workflow that halts for reasons nobody can see. Checking it here
 * turns that into a clean validation error.
 */
export function validateTemplate(template: WorkflowTemplate): readonly TemplateProblem[] {
  const problems: TemplateProblem[] = []

  if (template.id.trim() === '') {
    problems.push({ stepIndex: -1, detail: 'Template id must not be empty' })
  }
  if (template.name.trim() === '') {
    problems.push({ stepIndex: -1, detail: 'Template name must not be empty' })
  }
  if (template.steps.length === 0) {
    problems.push({ stepIndex: -1, detail: 'Template must define at least one step' })
    return problems
  }

  template.steps.forEach((step, index) => {
    const isForgeRole = step.role === 'system' || step.role === 'user'

    if (isForgeRole !== step.performedByForge) {
      problems.push({
        stepIndex: index,
        detail: isForgeRole
          ? `The "${step.role}" role is performed by Forge and must set performedByForge to true`
          : `The "${step.role}" role needs a runtime and must set performedByForge to false`,
      })
    }

    if (step.label.trim() === '') {
      problems.push({
        stepIndex: index,
        detail: `Step ${String(index + 1)} has an empty label`,
      })
    }
  })

  return problems
}

/**
 * Serializes a workflow template into formatted JSON.
 */
export function exportTemplateJson(template: WorkflowTemplate): string {
  return JSON.stringify(workflowTemplateSchema.parse(template), null, 2)
}

/**
 * Parses and validates a workflow template from JSON text.
 */
export function importTemplateJson(jsonText: string): {
  readonly template: WorkflowTemplate | null
  readonly problems: readonly TemplateProblem[]
} {
  try {
    const raw: unknown = JSON.parse(jsonText)
    const parsed = workflowTemplateSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        template: null,
        problems: parsed.error.issues.map((issue) => ({
          stepIndex: -1,
          detail: `${issue.path.join('.')}: ${issue.message}`,
        })),
      }
    }
    const problems = validateTemplate(parsed.data)
    if (problems.length > 0) {
      return { template: null, problems }
    }
    return { template: parsed.data, problems: [] }
  } catch (err) {
    return {
      template: null,
      problems: [
        {
          stepIndex: -1,
          detail: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
}

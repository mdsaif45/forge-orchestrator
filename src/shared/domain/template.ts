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
 *
 * The MVP ships one template. The engine that runs it stays data-driven anyway, because a
 * hardcoded sequence would have to be untangled later, and the cost of a table now is one
 * table.
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
 * The one template the MVP ships.
 *
 * Mirrors the loop the design describes: plan, approve, implement, verify, review — with the
 * correction cycle handled by the state machine rather than by extra template steps, since a
 * correction re-runs the same implement/verify/review steps at a higher iteration.
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
      // The human gate. Nothing an agent reports can substitute for it (A4), which is why it
      // is a step rather than an automatic transition.
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
      // Forge runs the build, the tests, and the diff itself. An agent's claim is not
      // evidence (A3), so this step exists precisely so the claim can be checked.
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

export const TEMPLATES = { feature: FEATURE_IMPLEMENTATION } as const satisfies Record<
  string,
  WorkflowTemplate
>

export type TemplateId = keyof typeof TEMPLATES

/** A template that could not be run, and why. */
export interface TemplateProblem {
  readonly stepIndex: number
  readonly detail: string
}

/**
 * Checks a template against the state machine.
 *
 * A template is a claim about a path through the machine, and a claim that does not hold
 * produces a workflow that halts at step three for reasons nobody can see. Checking it here
 * turns that into a startup-time error.
 *
 * Deliberately not a type-level guarantee: the transition table's legality depends on the
 * state a step *runs in*, which is a runtime property of the sequence rather than of any one
 * step.
 */
export function validateTemplate(template: WorkflowTemplate): readonly TemplateProblem[] {
  const problems: TemplateProblem[] = []

  template.steps.forEach((step, index) => {
    const isForgeRole = step.role === 'system' || step.role === 'user'

    // A role Forge performs must be marked as such, or the orchestrator would try to resolve
    // a binding for it and fail with a confusing "no runtime" error.
    if (isForgeRole !== step.performedByForge) {
      problems.push({
        stepIndex: index,
        detail: isForgeRole
          ? `The "${step.role}" role is performed by Forge and must set performedByForge`
          : `The "${step.role}" role needs a runtime and must not set performedByForge`,
      })
    }
  })

  return problems
}

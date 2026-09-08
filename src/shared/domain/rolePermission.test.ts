import { describe, expect, it } from 'vitest'
import { permissionForRole } from './rolePermission'

describe('permissionForRole', () => {
  it('runs a planner read-only', () => {
    // A planner cannot damage anything, so it needs no prompt to protect it — and a
    // prompt it cannot answer would stall the step forever (#166).
    expect(permissionForRole('planner', false).mode).toBe('plan')
  })

  it('runs a reviewer read-only', () => {
    expect(permissionForRole('reviewer', false).mode).toBe('plan')
  })

  it('lets an implementer that may write run without prompting', () => {
    // Measured: under acceptEdits a real turn ran its tools and then stopped on a
    // permission dialog with nothing present to answer it. An unattended step must
    // not depend on a prompt no one will see.
    expect(permissionForRole('implementer', true).mode).toBe('bypassPermissions')
  })

  it('keeps an implementer read-only when its binding withholds write permission', () => {
    // The role says what the step is for; the binding says what this agent is
    // allowed. The binding wins, or a permission the user deliberately withheld
    // would be granted back by the template (A7).
    expect(permissionForRole('implementer', false).mode).toBe('plan')
  })

  it('gives every decision a reason', () => {
    // A mode with no stated reason is a setting nobody can audit. Each of these
    // reaches a log line and a settings screen.
    for (const [role, mayWrite] of [
      ['planner', false],
      ['reviewer', false],
      ['implementer', true],
      ['implementer', false],
    ] as const) {
      expect(permissionForRole(role, mayWrite).reason.length).toBeGreaterThan(0)
    }
  })

  it('explains a withheld permission differently from a read-only role', () => {
    // "A planner does not modify the repository" and "this agent is not permitted
    // to write files" are different facts, and a user debugging a step that changed
    // nothing needs to know which one applies.
    const byRole = permissionForRole('planner', false).reason
    const byBinding = permissionForRole('implementer', false).reason
    expect(byRole).not.toBe(byBinding)
  })
})

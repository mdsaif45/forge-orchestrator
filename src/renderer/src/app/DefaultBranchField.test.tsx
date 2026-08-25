import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryProbe } from '@shared/ipc'
import { DefaultBranchField } from './DefaultBranchField'

/**
 * When the default branch is a fact and when it is a question (#140).
 *
 * The owner's complaint was that Forge asked for a value git had already answered. The
 * distinction these assert is not cosmetic: `origin/HEAD` is the remote stating its own
 * default, while `main` merely existing is a guess that happened to match, and a form
 * that presents both the same way is asking the user to rubber-stamp one of them.
 *
 * Asserted through the accessible role, not the markup: whether the control is present
 * is the whole behaviour, and a snapshot of classnames would pass while the field was
 * still a required input.
 */

// Built to the real type rather than cast, per the convention in WorkflowPreflight.test:
// a cast here would hide exactly the contract drift the new field introduces.
function probe(overrides: Partial<RepositoryProbe> = {}): RepositoryProbe {
  return {
    path: 'D:/code/thing',
    isRepository: true,
    branch: 'feature/wip',
    defaultBranch: 'main',
    defaultBranchSource: 'origin-head',
    branches: ['main', 'feature/wip'],
    headSha: 'a'.repeat(40),
    dirty: false,
    dirtyPaths: [],
    dirtyCount: 0,
    problems: [],
    ...overrides,
  }
}

describe('an authoritative answer is stated, not asked', () => {
  it('shows the branch and where it came from, with no input to fill in', () => {
    render(<DefaultBranchField probe={probe()} value="main" onChange={vi.fn()} />)

    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText(/from origin\/HEAD/)).toBeTruthy()

    // The point of the issue: nothing to answer. A combobox or textbox here means the
    // user is still being asked to confirm what git already reported.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('stays changeable, because a merge target can differ from origin/HEAD', () => {
    render(<DefaultBranchField probe={probe()} value="main" onChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: /change/i })).toBeTruthy()
  })
})

describe('an inference is still a question', () => {
  it('asks when the name was only a convention, and says so', () => {
    render(
      <DefaultBranchField
        probe={probe({ defaultBranchSource: 'convention' })}
        value="main"
        onChange={vi.fn()}
      />,
    )

    // `main` existing is not the remote saying it is the merge target, so the control
    // remains — with the weaker provenance named rather than implied.
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.getByText(/by convention/)).toBeTruthy()
  })

  it('asks when git could not determine a default at all (A2)', () => {
    render(
      <DefaultBranchField
        probe={probe({ defaultBranch: null, defaultBranchSource: null, branches: ['trunk'] })}
        value=""
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('combobox')).toBeTruthy()
    // No provenance claim when there is no provenance.
    expect(screen.queryByText(/origin\/HEAD/)).toBeNull()
  })

  it('asks when the value no longer matches what was detected', () => {
    // The user picked something else. Continuing to present origin/HEAD's answer as the
    // settled fact would misreport the value the form is actually going to submit.
    render(<DefaultBranchField probe={probe()} value="feature/wip" onChange={vi.fn()} />)

    expect(screen.getByRole('combobox')).toBeTruthy()
  })
})

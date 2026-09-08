import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryProbe } from '@shared/ipc'
import { DefaultBranchField } from './DefaultBranchField'

/**
 * When the default branch is a fact and when it is a question (#140).
 */

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

    expect(screen.getByLabelText(/default branch/i)).toBeTruthy()
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

    expect(screen.getByLabelText(/default branch/i)).toBeTruthy()
    expect(screen.queryByText(/origin\/HEAD/)).toBeNull()
  })

  it('asks when the value no longer matches what was detected', () => {
    render(<DefaultBranchField probe={probe()} value="feature/wip" onChange={vi.fn()} />)

    expect(screen.getByLabelText(/default branch/i)).toBeTruthy()
  })
})

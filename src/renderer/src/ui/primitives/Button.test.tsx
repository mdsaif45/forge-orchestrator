import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Button } from './Button'

describe('Button', () => {
  it('renders its label', () => {
    render(<Button>Lock decisions</Button>)

    expect(screen.getByRole('button', { name: 'Lock decisions' })).toBeInTheDocument()
  })

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Start</Button>)

    await userEvent.click(screen.getByRole('button'))

    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not call onClick while loading', async () => {
    // A slow action must not be double-submitted — starting a workflow twice
    // would run two agents against one working tree.
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Start
      </Button>,
    )

    await userEvent.click(screen.getByRole('button'))

    expect(onClick).not.toHaveBeenCalled()
  })

  it('marks itself busy while loading', () => {
    render(<Button loading>Start</Button>)

    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true')
  })

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Start
      </Button>,
    )

    await userEvent.click(screen.getByRole('button'))

    expect(onClick).not.toHaveBeenCalled()
  })

  it('lets a caller override a variant class', () => {
    // twMerge must resolve the conflict, otherwise the outcome would depend on
    // stylesheet order rather than on the call site.
    render(<Button className="px-9">Wide</Button>)

    const button = screen.getByRole('button')
    expect(button.className).toContain('px-9')
    expect(button.className).not.toContain('px-3')
  })

  it('forwards a ref to the underlying button', () => {
    let node: HTMLButtonElement | null = null
    render(
      <Button
        ref={(element) => {
          node = element
        }}
      >
        Ref
      </Button>,
    )

    expect(node).toBeInstanceOf(HTMLButtonElement)
  })
})

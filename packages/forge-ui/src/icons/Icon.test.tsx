import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Icon } from './Icon'
import { FORGE_ICON_REGISTRY, type ForgeIconName } from './registry'

describe('Icon (@forge/ui)', () => {
  it('renders every registered semantic icon without errors', () => {
    const names = Object.keys(FORGE_ICON_REGISTRY) as ForgeIconName[]
    expect(names.length).toBeGreaterThanOrEqual(40)

    for (const name of names) {
      const { container, unmount } = render(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  it('supports accessible role="img" labeling and spin animation class', () => {
    render(<Icon name="spinner" label="Workflow running" spin className="size-5" />)
    const img = screen.getByRole('img', { name: 'Workflow running' })
    expect(img.getAttribute('aria-hidden')).toBeNull()
    expect(img).toHaveClass('animate-spin', 'size-5')
  })
})

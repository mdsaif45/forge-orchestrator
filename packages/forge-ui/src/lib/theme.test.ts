import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from './theme'

describe('useTheme (@forge/ui)', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it('defaults to dark, toggles cleanly, and persists data-theme on root', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('forge.theme')).toBe('light')

    act(() => {
      result.current.setTheme('azure')
    })
    expect(document.documentElement.dataset.theme).toBe('azure')
  })
})

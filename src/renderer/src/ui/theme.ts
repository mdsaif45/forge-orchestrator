import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light' | 'system'

const STORAGE_KEY = 'forge.theme'

/**
 * Theme state, applied as `data-theme` on the root element.
 *
 * Supports 'dark', 'light', and 'system' (which tracks the OS preference).
 */
export function useTheme(): {
  readonly theme: Theme
  readonly setTheme: (theme: Theme) => void
  readonly toggleTheme: () => void
} {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    function applyTheme(): void {
      if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
      } else {
        document.documentElement.dataset.theme = theme
      }
    }

    applyTheme()
    localStorage.setItem(STORAGE_KEY, theme)

    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (): void => {
        applyTheme()
      }
      media.addEventListener('change', handler)
      return () => {
        media.removeEventListener('change', handler)
      }
    }
    return undefined
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, setTheme, toggleTheme }
}

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark'
}

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light' | 'azure' | 'system'

const STORAGE_KEY = 'forge.theme'

/**
 * Theme state, applied as `data-theme` on the root element.
 *
 * Supports 'dark', 'light', 'azure', and 'system' (which tracks the OS preference).
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

  useEffect(() => {
    const handleStorage = (e: StorageEvent): void => {
      if (
        e.key === STORAGE_KEY &&
        (e.newValue === 'light' ||
          e.newValue === 'dark' ||
          e.newValue === 'azure' ||
          e.newValue === 'system')
      ) {
        setThemeState(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

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
  if (stored === 'light' || stored === 'dark' || stored === 'azure' || stored === 'system') {
    return stored
  }
  const datasetTheme =
    typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined
  if (datasetTheme === 'light' || datasetTheme === 'dark' || datasetTheme === 'azure') {
    return datasetTheme
  }
  return 'dark'
}

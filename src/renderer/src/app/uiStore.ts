import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * UI-only state.
 *
 * **This store must never hold domain state** — no project, task, decision,
 * workflow, changeset, or question data. Those live in the main process behind
 * the IPC contract, because Forge owns the project truth and the renderer is a
 * view of it (axiom A1). Putting domain data here would create a second,
 * divergent copy that survives across restarts and quietly disagrees with the
 * database.
 *
 * What belongs here: layout, navigation affordances, panel sizes, dialog open states,
 * and other preferences that are meaningless outside this window.
 */
interface UiState {
  readonly sidebarCollapsed: boolean
  readonly toggleSidebar: () => void
  readonly setSidebarCollapsed: (collapsed: boolean) => void
  readonly settingsOpen: boolean
  readonly openSettings: () => void
  readonly closeSettings: () => void
  readonly toggleSettings: () => void
  readonly createProjectOpen: boolean
  readonly openCreateProject: () => void
  readonly closeCreateProject: () => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      settingsOpen: false,
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      toggleSettings: () => set((state) => ({ settingsOpen: !state.settingsOpen })),
      createProjectOpen: false,
      openCreateProject: () => set({ createProjectOpen: true }),
      closeCreateProject: () => set({ createProjectOpen: false }),
    }),
    {
      name: 'forge.ui',
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed }),
    },
  ),
)

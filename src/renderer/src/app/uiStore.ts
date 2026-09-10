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
  readonly terminalDrawerOpen: boolean
  readonly toggleTerminalDrawer: () => void
  readonly artifactsDrawerOpen: boolean
  readonly toggleArtifactsDrawer: () => void
  readonly filesDrawerOpen: boolean
  readonly toggleFilesDrawer: () => void
  readonly activeMode: 'chat' | 'code'
  readonly setActiveMode: (mode: 'chat' | 'code') => void
  readonly activeThreadTitle: string
  readonly setActiveThreadTitle: (title: string) => void
  readonly keepComputerAwake: boolean
  readonly setKeepComputerAwake: (awake: boolean) => void
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
      terminalDrawerOpen: false,
      toggleTerminalDrawer: () =>
        set((state) => ({ terminalDrawerOpen: !state.terminalDrawerOpen })),
      artifactsDrawerOpen: false,
      toggleArtifactsDrawer: () =>
        set((state) => ({ artifactsDrawerOpen: !state.artifactsDrawerOpen })),
      filesDrawerOpen: false,
      toggleFilesDrawer: () => set((state) => ({ filesDrawerOpen: !state.filesDrawerOpen })),
      activeMode: 'chat',
      setActiveMode: (activeMode) => set({ activeMode }),
      activeThreadTitle: 'Project overview',
      setActiveThreadTitle: (activeThreadTitle) => set({ activeThreadTitle }),
      keepComputerAwake: false,
      setKeepComputerAwake: (keepComputerAwake) => set({ keepComputerAwake }),
    }),
    {
      name: 'forge.ui',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        activeMode: state.activeMode,
        activeThreadTitle: state.activeThreadTitle,
      }),
    },
  ),
)

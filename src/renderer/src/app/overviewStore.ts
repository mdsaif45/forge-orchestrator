import { create } from 'zustand'

export interface OverviewSubagent {
  readonly id: string
  readonly role: string
  readonly prompt: string
  readonly status: 'running' | 'idle' | 'completed' | 'failed'
  readonly timestamp: number
  readonly model?: string | undefined
}

export interface OverviewArtifact {
  readonly id: string
  readonly name: string
  readonly path?: string | undefined
  readonly type?: string | undefined
  readonly updatedAt: string
  readonly summary?: string | undefined
  readonly content?: string | undefined
}

export interface OverviewUpload {
  readonly id: string
  readonly name: string
  readonly url?: string | undefined
  readonly timestamp: string
  readonly type?: string | undefined
  readonly size?: number | undefined
}

export interface OverviewBackgroundTask {
  readonly id: string
  readonly command: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly startedAt: string
}

export interface OverviewTerminal {
  readonly id: string
  readonly name: string
  readonly active: boolean
}

export interface OverviewFileChange {
  readonly path: string
  readonly status: 'M' | 'M+' | 'A' | 'D' | '?'
  readonly directory: string
  readonly fullPath?: string | undefined
}

export interface WorkspaceTab {
  readonly id: string
  readonly kind: 'file' | 'artifact' | 'terminal'
  readonly title: string
  readonly subtitle?: string | undefined
  readonly filePath?: string | undefined
  readonly directory?: string | undefined
  readonly artifactId?: string | undefined
  readonly content?: string | undefined
}

interface OverviewState {
  readonly isOpen: boolean
  readonly isExpanded: boolean
  readonly isDraggingSplitter: boolean
  readonly panelMode: 'overview' | 'tab'
  readonly activeFilter: 'uncommitted' | 'branch' | 'agent_edits'
  readonly isFilterDropdownOpen: boolean

  // Dynamic collections (defaults to empty: 0 counts unless active in session)
  readonly subagents: readonly OverviewSubagent[]
  readonly artifacts: readonly OverviewArtifact[]
  readonly uploads: readonly OverviewUpload[]
  readonly backgroundTasks: readonly OverviewBackgroundTask[]
  readonly terminals: readonly OverviewTerminal[]
  readonly filesChanged: readonly OverviewFileChange[]
  readonly agentEditedFiles: readonly string[]

  // Right Panel Tabs
  readonly tabs: readonly WorkspaceTab[]
  readonly activeTabId: string | null

  readonly panelWidth: number
  readonly setPanelWidth: (width: number) => void
  readonly setIsDraggingSplitter: (dragging: boolean) => void

  readonly toggleOpen: () => void
  readonly setOpen: (open: boolean) => void
  readonly toggleExpanded: () => void
  readonly showOverview: () => void
  readonly setActiveFilter: (filter: 'uncommitted' | 'branch' | 'agent_edits') => void
  readonly setFilterDropdownOpen: (open: boolean) => void
  readonly openTab: (tab: WorkspaceTab) => void
  readonly closeTab: (tabId: string) => void
  readonly setActiveTab: (tabId: string) => void

  readonly registerSubagent: (subagent: OverviewSubagent) => void
  readonly updateSubagentStatus: (id: string, status: OverviewSubagent['status']) => void
  readonly addSessionArtifact: (artifact: OverviewArtifact) => void
  readonly addSessionUpload: (upload: OverviewUpload) => void
  readonly recordAgentEdit: (filePath: string) => void
  readonly addBackgroundTask: (task: OverviewBackgroundTask) => void
  readonly updateBackgroundTask: (id: string, status: OverviewBackgroundTask['status']) => void
  readonly setTerminals: (terminals: readonly OverviewTerminal[]) => void
  readonly setFilesChanged: (files: readonly OverviewFileChange[]) => void
}

function loadSavedPanelOpen(): boolean {
  try {
    const saved = localStorage.getItem('forge.overview_panel_open')
    if (saved !== null) {
      return saved === 'true'
    }
  } catch {
    // ignore
  }
  return true
}

function loadSavedPanelWidth(): number {
  try {
    const saved = localStorage.getItem('forge.overview_panel_width')
    if (saved !== null) {
      const parsed = parseInt(saved, 10)
      if (!Number.isNaN(parsed) && parsed >= 280 && parsed <= 1200) {
        return parsed
      }
    }
  } catch {
    // ignore
  }
  return 440
}

export const useOverviewStore = create<OverviewState>((set) => ({
  isOpen: loadSavedPanelOpen(),
  isExpanded: false,
  isDraggingSplitter: false,
  panelWidth: loadSavedPanelWidth(),
  panelMode: 'overview',
  activeFilter: 'uncommitted',
  isFilterDropdownOpen: false,

  // Zero hardcoded dummy data: all collections start empty
  subagents: [],
  artifacts: [],
  uploads: [],
  backgroundTasks: [],
  terminals: [],
  filesChanged: [],
  agentEditedFiles: [],

  tabs: [],
  activeTabId: null,

  setIsDraggingSplitter: (dragging) => {
    set({ isDraggingSplitter: dragging })
  },

  toggleOpen: () => {
    set((state) => {
      const next = !state.isOpen
      try {
        localStorage.setItem('forge.overview_panel_open', String(next))
      } catch {
        // ignore
      }
      return {
        isOpen: next,
        ...(next ? {} : { isExpanded: false }),
      }
    })
  },

  setOpen: (open) => {
    try {
      localStorage.setItem('forge.overview_panel_open', String(open))
    } catch {
      // ignore
    }
    set({
      isOpen: open,
      ...(open ? {} : { isExpanded: false }),
    })
  },

  setPanelWidth: (width) => {
    const clamped = Math.max(280, Math.min(1200, Math.round(width)))
    try {
      localStorage.setItem('forge.overview_panel_width', String(clamped))
    } catch {
      // ignore
    }
    set({ panelWidth: clamped })
  },

  toggleExpanded: () => {
    set((state) => ({ isExpanded: !state.isExpanded }))
  },

  showOverview: () => {
    set({ panelMode: 'overview' })
  },

  setActiveFilter: (filter) => {
    set({ activeFilter: filter, isFilterDropdownOpen: false })
  },

  setFilterDropdownOpen: (open) => {
    set({ isFilterDropdownOpen: open })
  },

  openTab: (tab) => {
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id)
      if (existing) {
        return {
          activeTabId: tab.id,
          panelMode: 'tab',
        }
      }
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        panelMode: 'tab',
      }
    })
  },

  closeTab: (tabId) => {
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId)
      if (nextTabs.length === 0) {
        return {
          tabs: [],
          activeTabId: null,
          panelMode: 'overview',
        }
      }
      let nextActiveId = state.activeTabId
      if (state.activeTabId === tabId) {
        const closedIdx = state.tabs.findIndex((t) => t.id === tabId)
        const fallback = nextTabs[Math.max(0, closedIdx - 1)] ?? nextTabs[0]
        nextActiveId = fallback ? fallback.id : null
      }
      return {
        tabs: nextTabs,
        activeTabId: nextActiveId,
        panelMode: nextActiveId ? 'tab' : 'overview',
      }
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId, panelMode: 'tab' })
  },

  registerSubagent: (subagent) => {
    set((state) => ({
      subagents: [subagent, ...state.subagents.filter((s) => s.id !== subagent.id)],
    }))
  },

  updateSubagentStatus: (id, status) => {
    set((state) => ({
      subagents: state.subagents.map((s) => (s.id === id ? { ...s, status } : s)),
    }))
  },

  addSessionArtifact: (artifact) => {
    set((state) => ({
      artifacts: [artifact, ...state.artifacts.filter((a) => a.id !== artifact.id)],
    }))
  },

  addSessionUpload: (upload) => {
    set((state) => ({
      uploads: [upload, ...state.uploads.filter((u) => u.id !== upload.id)],
    }))
  },

  recordAgentEdit: (filePath) => {
    set((state) => ({
      agentEditedFiles: Array.from(new Set([...state.agentEditedFiles, filePath])),
    }))
  },

  addBackgroundTask: (task) => {
    set((state) => ({
      backgroundTasks: [task, ...state.backgroundTasks.filter((t) => t.id !== task.id)],
    }))
  },

  updateBackgroundTask: (id, status) => {
    set((state) => ({
      backgroundTasks: state.backgroundTasks.map((t) => (t.id === id ? { ...t, status } : t)),
    }))
  },

  setTerminals: (terminals) => {
    set({ terminals })
  },

  setFilesChanged: (filesChanged) => {
    set({ filesChanged })
  },
}))

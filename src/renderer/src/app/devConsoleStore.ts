import { create } from 'zustand'

export interface DevToolExecution {
  readonly round?: number | undefined
  readonly name: string
  readonly args: unknown
  readonly ok: boolean
  readonly output: string
  readonly durationMs?: number | undefined
}

export interface DevStreamTimelineItem {
  readonly kind: 'reasoning' | 'tool' | 'content'
  readonly text: string
}

export interface DevNetworkTransaction {
  readonly id: string
  readonly timestamp: number
  readonly timeFormatted: string
  readonly type: 'agent_turn' | 'chat_stream' | 'model_call'
  readonly status: 'pending' | 'success' | 'error'
  readonly statusCode: number
  readonly durationMs?: number | undefined
  readonly model: string
  readonly providerId: string
  readonly endpointUrl: string
  readonly round?: number | undefined
  readonly request: {
    readonly method: string
    readonly url: string
    readonly headers: Record<string, string>
    readonly body: unknown
    readonly promptSummary?: string | undefined
    readonly systemPrompt?: string | undefined
    readonly messagesCount?: number | undefined
  }
  readonly response?:
    | {
        readonly status: number
        readonly statusText: string
        readonly durationMs: number
        readonly content?: string | undefined
        readonly reasoning?: string | undefined
        readonly toolCallsCount?: number | undefined
        readonly rawBody?: unknown
        readonly error?: string | null | undefined
      }
    | undefined
  readonly toolExecutions?: readonly DevToolExecution[] | undefined
  readonly streamTimeline?: readonly DevStreamTimelineItem[] | undefined
}

interface DevConsoleState {
  readonly isOpen: boolean
  readonly dockPosition: 'bottom' | 'right'
  readonly bottomHeightPct: number
  readonly rightWidthPx: number
  readonly transactions: readonly DevNetworkTransaction[]
  readonly selectedTransactionId: string | null
  readonly filterText: string

  readonly openDevConsole: () => void
  readonly closeDevConsole: () => void
  readonly toggleDevConsole: () => void
  readonly setDockPosition: (pos: 'bottom' | 'right') => void
  readonly setBottomHeightPct: (pct: number) => void
  readonly setRightWidthPx: (px: number) => void
  readonly recordTransaction: (tx: DevNetworkTransaction) => void
  readonly updateTransaction: (
    id: string,
    updater: (prev: DevNetworkTransaction) => DevNetworkTransaction,
  ) => void
  readonly selectTransaction: (id: string | null) => void
  readonly clearTransactions: () => void
  readonly setFilterText: (text: string) => void
}

const MAX_TRANSACTIONS = 100

function loadSavedDock(): 'bottom' | 'right' {
  try {
    const saved = localStorage.getItem('forge.dev_console_dock')
    if (saved === 'bottom' || saved === 'right') return saved
  } catch {
    // ignore
  }
  return 'bottom'
}

function loadSavedHeight(): number {
  try {
    const saved = localStorage.getItem('forge.dev_console_height')
    if (saved) {
      const parsed = Number.parseInt(saved, 10)
      if (!Number.isNaN(parsed) && parsed >= 15 && parsed <= 80) return parsed
    }
  } catch {
    // ignore
  }
  return 25 // 1/4 of the screen by default
}

function loadSavedWidth(): number {
  try {
    const saved = localStorage.getItem('forge.dev_console_width')
    if (saved) {
      const parsed = Number.parseInt(saved, 10)
      if (!Number.isNaN(parsed) && parsed >= 280 && parsed <= 900) return parsed
    }
  } catch {
    // ignore
  }
  return 480
}

export const useDevConsoleStore = create<DevConsoleState>((set) => ({
  isOpen: false,
  dockPosition: loadSavedDock(),
  bottomHeightPct: loadSavedHeight(),
  rightWidthPx: loadSavedWidth(),
  transactions: [],
  selectedTransactionId: null,
  filterText: '',

  openDevConsole: () => {
    set({ isOpen: true })
  },
  closeDevConsole: () => {
    set({ isOpen: false })
  },
  toggleDevConsole: () => {
    set((state) => ({ isOpen: !state.isOpen }))
  },

  setDockPosition: (pos) => {
    try {
      localStorage.setItem('forge.dev_console_dock', pos)
    } catch {
      // ignore
    }
    set({ dockPosition: pos })
  },

  setBottomHeightPct: (pct) => {
    const clamped = Math.max(15, Math.min(80, Math.round(pct)))
    try {
      localStorage.setItem('forge.dev_console_height', String(clamped))
    } catch {
      // ignore
    }
    set({ bottomHeightPct: clamped })
  },

  setRightWidthPx: (px) => {
    const clamped = Math.max(280, Math.min(900, Math.round(px)))
    try {
      localStorage.setItem('forge.dev_console_width', String(clamped))
    } catch {
      // ignore
    }
    set({ rightWidthPx: clamped })
  },

  recordTransaction: (tx) => {
    set((state) => {
      const exists = state.transactions.some((t) => t.id === tx.id)
      let updated: readonly DevNetworkTransaction[]
      if (exists) {
        updated = state.transactions.map((t) => (t.id === tx.id ? tx : t))
      } else {
        updated = [...state.transactions, tx]
        if (updated.length > MAX_TRANSACTIONS) {
          updated = updated.slice(updated.length - MAX_TRANSACTIONS)
        }
      }
      return {
        transactions: updated,
        selectedTransactionId: state.selectedTransactionId ?? tx.id,
      }
    })
  },

  updateTransaction: (id, updater) => {
    set((state) => ({
      transactions: state.transactions.map((t) => (t.id === id ? updater(t) : t)),
    }))
  },

  selectTransaction: (id) => {
    set({ selectedTransactionId: id })
  },

  clearTransactions: () => {
    if (window.forge.dev) {
      void window.forge.dev.clearModelCalls()
    }
    set({ transactions: [], selectedTransactionId: null })
  },

  setFilterText: (text) => {
    set({ filterText: text })
  },
}))

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CreateProjectRequest, ProjectDetail, ProjectView } from '@shared/ipc'
import { unwrap } from '../ipc'

/**
 * Projects, as the renderer currently sees them.
 *
 * This is a **cache of what main reported**, not a second source of truth. The
 * distinction is what keeps axiom A1 intact, and it shows up in two rules:
 *
 *   1. every mutation goes to main and the result is re-read, never patched in
 *      place from what the form submitted
 *   2. only `selectedProjectId` is persisted — a pointer, not the data. Persisting
 *      project rows would leave a stale copy on disk that survives a restart and
 *      disagrees with the database.
 *
 * `uiStore` is for layout preferences; this holds fetched domain data for the
 * duration of a session. They are kept apart so the persistence rule above is
 * obvious rather than a detail buried in one `partialize` call.
 */
interface ProjectState {
  readonly projects: readonly ProjectView[]
  readonly selectedProjectId: string | null
  readonly detail: ProjectDetail | null
  readonly loading: boolean
  readonly error: string | null

  readonly refresh: () => Promise<void>
  readonly select: (projectId: string | null) => Promise<void>
  readonly createProject: (request: CreateProjectRequest) => Promise<ProjectView>
  readonly applyRule: (scope: string, key: string, statement: string) => Promise<void>
  readonly removeRule: (ruleId: string) => Promise<void>
  readonly deleteProject: (projectId: string) => Promise<void>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unknown error'
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      selectedProjectId: null,
      detail: null,
      loading: false,
      error: null,

      /**
       * Reloads the project list and the selected project's detail.
       *
       * The remembered selection is validated against what main returned: a project
       * whose row is gone — a database restored from a backup, or a hand-edited
       * file — must not leave the shell pointing at something that no longer exists.
       */
      refresh: async () => {
        set({ loading: true, error: null })

        try {
          const { projects } = await window.forge.project.list().then(unwrap)

          const remembered = get().selectedProjectId
          const stillExists = projects.some((project) => project.id === remembered)
          const selectedProjectId = stillExists ? remembered : (projects.at(0)?.id ?? null)

          const detail =
            selectedProjectId === null
              ? null
              : await window.forge.project.get(selectedProjectId).then(unwrap)

          set({ projects, selectedProjectId, detail, loading: false })
        } catch (cause) {
          set({ loading: false, error: message(cause) })
        }
      },

      select: async (projectId) => {
        set({ selectedProjectId: projectId, error: null })

        if (projectId === null) {
          set({ detail: null })
          return
        }

        try {
          set({ detail: await window.forge.project.get(projectId).then(unwrap) })
        } catch (cause) {
          set({ error: message(cause) })
        }
      },

      /**
       * Creates a project in main, then re-reads it.
       *
       * The returned view is not merged into the list directly: main assigns ids and
       * normalises the path, so re-reading is how the renderer learns what was
       * actually stored rather than what was requested.
       */
      createProject: async (request) => {
        const created = await window.forge.project.create(request).then(unwrap)

        set({ selectedProjectId: created.id })
        await get().refresh()

        return created
      },

      /**
       * Sets a rule and stores the detail main returned.
       *
       * Main resolves the policy and sends the whole detail back, so the displayed
       * inheritance is what the resolver actually computed rather than a local guess
       * at what the change implied.
       */
      applyRule: async (scope, key, statement) => {
        const projectId = get().selectedProjectId
        if (projectId === null) return

        const detail = await window.forge.rule.set(projectId, scope, key, statement).then(unwrap)
        set({ detail })
      },

      removeRule: async (ruleId) => {
        const projectId = get().selectedProjectId
        if (projectId === null) return

        const detail = await window.forge.rule.remove(projectId, ruleId).then(unwrap)
        set({ detail })
      },

      deleteProject: async (projectId) => {
        set({ loading: true })
        try {
          await window.forge.project.delete(projectId).then(unwrap)
          const remainingProjects = get().projects.filter((p) => p.id !== projectId)
          const nextSelected = remainingProjects.at(0)?.id ?? null
          set({
            projects: remainingProjects,
            selectedProjectId: nextSelected,
            detail: null,
            loading: false,
            error: null,
          })
          await get().refresh()
        } catch (cause) {
          set({ loading: false })
          throw cause
        }
      },
    }),
    {
      name: 'forge.projects',
      // A pointer only. See the note above: persisting rows would create a second
      // truth that outlives the session.
      partialize: (state) => ({ selectedProjectId: state.selectedProjectId }),
    },
  ),
)

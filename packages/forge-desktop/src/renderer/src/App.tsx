import { createHashRouter, Navigate, RouterProvider } from 'react-router'
import { NotFound } from './app/NotFound'
import { Overview } from './app/Overview'
import { ROUTES } from './app/routes'
import { Settings } from './app/Settings'
import { Shell } from './app/Shell'
import { ToastProvider } from './ui'

import { WorkflowPage } from './app/workflow/WorkflowPage'
import { ChangesPage } from './app/ChangesPage'
import { AgentsPage } from './app/AgentsPage'
import { AskPage } from './app/AskPage'

/**
 * Routes are generated from the route table, so navigation and routing cannot
 * disagree and a nav item cannot point at a dead link.
 *
 * A hash router, not a browser router: the packaged app loads from `file://`,
 * where path-based history has no server to resolve against and a reload would
 * fail.
 */
const router = createHashRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      ...ROUTES.map((route) => {
        // React Router expresses the index route as `index: true`, not as a path.
        if (route.path === '/') return { index: true as const, element: <Overview /> }
        if (route.path === '/ask') return { path: 'ask', element: <AskPage /> }
        if (route.path === '/workflows') return { path: 'workflows', element: <WorkflowPage /> }
        if (route.path === '/changes') return { path: 'changes', element: <ChangesPage /> }
        if (route.path === '/agents') return { path: 'agents', element: <AgentsPage /> }
        return { path: 'settings', element: <Settings /> }
      }),
      // Backward-compatible redirects: human Q&A and decision locks are thread-native inside /workflows
      { path: 'questions', element: <Navigate to="/workflows" replace /> },
      { path: 'decisions', element: <Navigate to="/workflows" replace /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  )
}

import { createHashRouter, RouterProvider } from 'react-router'
import { NotFound } from './app/NotFound'
import { Overview } from './app/Overview'
import { RoutePlaceholder } from './app/RoutePlaceholder'
import { ROUTES } from './app/routes'
import { Settings } from './app/Settings'
import { Shell } from './app/Shell'
import { ToastProvider } from './ui'

import { WorkflowPage } from './app/workflow/WorkflowPage'
import { QuestionsPage } from './app/QuestionsPage'
import { DecisionsPage } from './app/DecisionsPage'

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
        if (route.path === '/workflows') return { path: 'workflows', element: <WorkflowPage /> }
        if (route.path === '/questions') return { path: 'questions', element: <QuestionsPage /> }
        if (route.path === '/decisions') return { path: 'decisions', element: <DecisionsPage /> }
        if (route.path === '/settings') return { path: 'settings', element: <Settings /> }
        return { path: route.path.slice(1), element: <RoutePlaceholder route={route} /> }
      }),
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

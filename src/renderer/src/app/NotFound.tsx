import { useNavigate } from 'react-router'
import { Button, Code, EmptyState } from '../ui'

/**
 * Catch-all route.
 *
 * Should be unreachable, since navigation is generated from the route table —
 * which is exactly why it exists: if it ever renders, a link was built by hand
 * and the table stopped being the single source of truth.
 */
export function NotFound(): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <div className="grid h-full place-content-center">
      <EmptyState
        title="Route not found"
        description="Navigation is generated from the route table, so this should be unreachable. If you are seeing it, a link was constructed by hand."
        action={
          <div className="flex flex-col items-center gap-3">
            <Code>{window.location.hash || window.location.pathname}</Code>
            <Button variant="secondary" onClick={() => void navigate('/')}>
              Back to overview
            </Button>
          </div>
        }
      />
    </div>
  )
}

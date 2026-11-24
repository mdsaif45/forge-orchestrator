import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, useToast } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'

interface EnrollmentState {
  readonly isolatable: boolean
  readonly home: string | null
  readonly loggedIn: boolean
  readonly email: string | null
}

export interface AccountEnrollmentProps {
  readonly accountId: string
  /** Which CLI this account signs into. Isolation is a property of that runtime. */
  readonly runtimeId: string
}

/**
 * Sign-in state for one account, and the control that starts it.
 *
 * Forge never handles the credential: pressing "Sign in" opens the user's own terminal
 * with an isolated home, the vendor CLI performs the login and writes its own
 * credential there, and Forge learns the outcome by asking `auth status` afterwards.
 *
 * State is probed rather than remembered. A credential expires, and a stored
 * "connected" flag would keep asserting it long after it stopped being true — the
 * unverified claim A3 exists to prevent, applied to auth instead of to work.
 */
export function AccountEnrollment({
  accountId,
  runtimeId,
}: AccountEnrollmentProps): React.JSX.Element {
  const { show } = useToast()
  const [state, setState] = useState<EnrollmentState | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    window.forge.account
      .enrollmentStatus(accountId, runtimeId)
      .then((res) => {
        const status = unwrap(res)
        setState({
          isolatable: status.isolatable,
          home: status.home,
          loggedIn: status.loggedIn,
          email: status.email,
        })
      })
      .catch((err: unknown) => {
        console.error('Failed to read enrollment status:', err)
      })
  }, [accountId, runtimeId])

  useEffect(refresh, [refresh])

  const handleSignIn = async (): Promise<void> => {
    setBusy(true)
    try {
      unwrap(await window.forge.account.beginEnrollment(accountId, runtimeId))
      show({
        tone: 'success',
        title: 'Sign-in opened in a terminal',
        description:
          'Complete the login there. Forge never sees your password or token — the CLI writes its own credential.',
      })
    } catch (err: unknown) {
      // The most likely cause is a runtime that cannot isolate accounts, and the user
      // can only act on that if told plainly.
      show({
        tone: 'danger',
        title: 'Cannot start sign-in',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  if (state === null) {
    return <span className="text-(length:--text-xs) text-(--color-text-muted)">checking…</span>
  }

  if (!state.isolatable) {
    // Not the same as "not signed in", and the remedy is different: this provider
    // keeps one credential per machine, so a second account cannot be kept apart
    // (#111). Saying "sign in" here would promise something the platform cannot do.
    return (
      <Badge tone="neutral" size="sm">
        one account per machine
      </Badge>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {state.loggedIn ? (
        <Badge tone="success" size="sm">
          {state.email ?? 'signed in'}
        </Badge>
      ) : (
        <Badge tone="warning" size="sm">
          not signed in
        </Badge>
      )}

      <Button
        size="sm"
        variant={state.loggedIn ? 'ghost' : 'secondary'}
        disabled={busy}
        onClick={() => {
          void handleSignIn()
        }}
      >
        {state.loggedIn ? 'Sign in again' : 'Sign in'}
      </Button>

      {/* Manual, because the sign-in happens in a window Forge deliberately does not
          watch — there is no exit code to react to. */}
      <Button size="sm" variant="ghost" onClick={refresh}>
        Recheck
      </Button>
    </div>
  )
}

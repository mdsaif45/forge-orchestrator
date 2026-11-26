import { useState } from 'react'
import type { RoleBindingsView } from '@shared/ipc'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Textarea,
} from '@renderer/ui'

export interface ThreadComposerProps {
  readonly isTerminal: boolean
  readonly isAwaitingApproval: boolean
  readonly activeStepIndex: number
  readonly bindings: RoleBindingsView | null
  readonly actionInProgress: boolean
  readonly onInterject: (stepIndex: number, text: string) => Promise<void>
  readonly onStartNextCycle: (objective: string) => Promise<void>
  readonly onSwitchRoleRuntime: (role: string, runtimeId: string) => Promise<void>
  readonly onApproveAndImplement: () => Promise<void>
}

const EDITABLE_ROLES: readonly { readonly role: string; readonly label: string }[] = [
  { role: 'planner', label: 'Planner' },
  { role: 'implementer', label: 'Implementer' },
  { role: 'reviewer', label: 'Reviewer' },
]

/**
 * Continuous loop composer docked at the bottom of the workflow execution thread:
 * lets operators guide an active step inline, switch agent runtimes mid-thread,
 * approve ready plans, or initiate a follow-up development cycle in the same thread.
 */
export function ThreadComposer({
  isTerminal,
  isAwaitingApproval,
  activeStepIndex,
  bindings,
  actionInProgress,
  onInterject,
  onStartNextCycle,
  onSwitchRoleRuntime,
  onApproveAndImplement,
}: ThreadComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || submitting) return
    setSubmitting(true)
    try {
      if (isTerminal) {
        await onStartNextCycle(text)
      } else {
        await onInterject(activeStepIndex, text)
      }
      setDraft('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-(--color-edge) bg-(--color-surface) px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-(--reading-column-wide) flex-col gap-2 rounded-(--radius-xl) border border-(--color-edge) bg-(--color-surface-raised) p-2.5 shadow-(--elevation-raised)">
        <Textarea
          aria-label={isTerminal ? 'Next cycle objective' : 'Thread guidance prompt'}
          placeholder={
            isTerminal
              ? 'Describe the next feature, fix, or planning iteration in this thread...'
              : 'Send inline guidance or redirect the active agent step...'
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          rows={2}
          className="min-h-12 resize-none border-0 bg-transparent px-1.5 py-1 focus-visible:ring-0"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--color-edge-muted) pt-2">
          {/* Mid-thread Role / Model Switcher */}
          <div className="flex flex-wrap items-center gap-1.5">
            {bindings !== null ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" className="gap-1.5 text-(--color-text-muted)">
                    <Icon name="subagent" className="size-3.5 text-(--color-accent)" />
                    <span>Switch role runtime</span>
                    <Icon name="chevron-down" className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-72">
                  {EDITABLE_ROLES.map((item, idx) => {
                    const roleEntry = bindings.roles.find((r) => r.role === item.role)
                    if (roleEntry === undefined) return null
                    const currentId = roleEntry.binding?.runtimeId ?? null
                    return (
                      <DropdownMenuGroup key={item.role}>
                        {idx > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>
                          {item.label} ({currentId ?? 'unbound'})
                        </DropdownMenuLabel>
                        {roleEntry.eligibleRuntimes.map((rt) => (
                          <DropdownMenuItem
                            key={`${item.role}-${rt.id}`}
                            onClick={() => {
                              void onSwitchRoleRuntime(item.role, rt.id)
                            }}
                            className="justify-between"
                          >
                            <span className="font-mono typography-meta">
                              {rt.id}
                              {rt.simulated ? ' (sim)' : ''}
                            </span>
                            {rt.id === currentId ? (
                              <Icon name="check" className="size-3.5 text-(--color-accent)" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <span className="hidden typography-micro text-(--color-text-subtle) sm:inline">
              Ctrl+Enter to send
            </span>
          </div>

          <div className="flex items-center gap-2">
            {isAwaitingApproval ? (
              <Button
                variant="primary"
                size="sm"
                disabled={actionInProgress}
                onClick={() => {
                  void onApproveAndImplement()
                }}
              >
                <Icon name="lock" className="size-3.5" />
                <span>Approve & Implement</span>
              </Button>
            ) : null}

            <Button
              variant={isAwaitingApproval ? 'secondary' : 'primary'}
              size="sm"
              loading={submitting}
              disabled={draft.trim().length === 0 || actionInProgress}
              onClick={() => {
                void handleSubmit()
              }}
            >
              <Icon name={isTerminal ? 'play' : 'send'} className="size-3.5" />
              <span>{isTerminal ? 'Run next cycle' : 'Send guidance'}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

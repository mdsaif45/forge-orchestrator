import React, { useEffect, useState } from 'react'
import type { PromptPacketView, WorkflowStepView } from '@shared/ipc'
import { Badge, Button, MarkdownRenderer, Spinner, TabPanel, Tabs } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'

export interface StepInspectorProps {
  readonly step: WorkflowStepView | null
  readonly onClose?: () => void
}

type StepTab = 'summary' | 'packet' | 'verdict'

/**
 * Four tabs became three.
 *
 * "Live Console & Output" rendered the same log the terminal below already shows, at a
 * third of the width — two panes competing to be the place you watch. The terminal won,
 * because it is the one the user asked to be real.
 *
 * "Prompt Packet" stays but is renamed: it is the exact text Forge sent this agent, and
 * it is the only way to tell a bad instruction from a bad agent. "Prompt Packet" named
 * Forge's internal type; "Instruction Sent" names what the user is looking at.
 */
const TAB_ITEMS: readonly { readonly value: StepTab; readonly label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'packet', label: 'Instruction Sent' },
  { value: 'verdict', label: 'Verdict & Evidence' },
]

export function StepInspector({ step, onClose }: StepInspectorProps): React.JSX.Element {
  const [packetState, setPacketState] = useState<{
    ref: string
    packet: PromptPacketView | null
  } | null>(null)
  const [activeTab, setActiveTab] = useState<StepTab>('summary')

  const loading =
    step?.contextRef !== undefined &&
    step.contextRef !== null &&
    packetState?.ref !== step.contextRef

  const packet =
    step?.contextRef !== undefined &&
    step.contextRef !== null &&
    packetState?.ref === step.contextRef
      ? packetState.packet
      : null

  useEffect(() => {
    if (step?.contextRef === undefined || step.contextRef === null) {
      return
    }

    const ref = step.contextRef
    let cancelled = false

    window.forge.workflow
      .getPacket(ref)
      .then((res) => {
        if (!cancelled) {
          setPacketState({ ref, packet: unwrap(res) })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPacketState({ ref, packet: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [step?.contextRef])

  if (step === null) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-6 text-center text-[13px] text-(--color-text-muted)">
        Click any stage node in the workflow graph to inspect live terminal logs, prompt packets,
        and findings.
      </div>
    )
  }

  const personaName =
    step.role === 'planner'
      ? 'Alex (Planner)'
      : step.role === 'user'
        ? 'You (Approval Gate)'
        : step.role === 'implementer'
          ? 'Sam (Implementer)'
          : step.role === 'reviewer'
            ? 'Morgan (Reviewer)'
            : 'Forge Engine'

  return (
    <div className="flex h-full flex-col rounded-xl border border-(--color-border) bg-(--color-surface-raised) text-[13px] shadow-xs overflow-hidden">
      {/* Step Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface) p-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-(--color-text)">{personaName}</span>
          <Badge
            tone={
              step.state === 'completed'
                ? 'success'
                : step.state === 'running'
                  ? 'info'
                  : step.state === 'failed' || step.state === 'halted'
                    ? 'danger'
                    : 'neutral'
            }
            size="sm"
          >
            {step.state}
          </Badge>
          {step.verdict !== null && (
            <Badge
              tone={
                step.verdict === 'pass' ? 'success' : step.verdict === 'fail' ? 'danger' : 'neutral'
              }
              size="sm"
            >
              {step.simulated === true ? `sim ${step.verdict}` : step.verdict}
            </Badge>
          )}
        </div>

        {onClose !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="h-6 px-2 text-[11px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            ✕ Close
          </Button>
        )}
      </div>

      {/* Tabs Navigation */}
      <div className="border-b border-(--color-border) bg-(--color-surface)/50 px-3 pt-2">
        <Tabs
          items={TAB_ITEMS}
          value={activeTab}
          onChange={(tab) => {
            setActiveTab(tab)
          }}
          aria-label="Step Inspection Tabs"
        />
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* SUMMARY TAB */}
        <TabPanel active={activeTab === 'summary'}>
          <div className="space-y-4">
            <div className="rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-3">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                <div>
                  <span className="font-semibold text-(--color-text-muted)">Stage Index:</span>
                  <p className="font-mono text-(--color-text)">Stage {String(step.index + 1)}</p>
                </div>
                <div>
                  <span className="font-semibold text-(--color-text-muted)">Assigned Role:</span>
                  <p className="font-semibold text-(--color-text)">{step.role.toUpperCase()}</p>
                </div>
                <div>
                  <span className="font-semibold text-(--color-text-muted)">Runtime Engine:</span>
                  <p className="font-mono text-(--color-accent)">
                    {step.runtimeId ??
                      (step.role === 'user' ? 'Human Gate' : 'system / Forge internal')}
                  </p>
                </div>
                <div>
                  <span className="font-semibold text-(--color-text-muted)">Status:</span>
                  <p className="font-semibold text-(--color-text)">{step.state}</p>
                </div>
              </div>
            </div>

            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">
                Timing & Execution:
              </span>
              <p className="mt-1 font-mono text-[11px] text-(--color-text-muted)">
                Started: {step.startedAt ?? 'Pending'} <br />
                Finished: {step.finishedAt ?? (step.state === 'running' ? 'In progress...' : '—')}
              </p>
            </div>

            {step.reportStatus !== null && (
              <div className="rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-3">
                <span className="text-[11px] font-semibold text-(--color-text-muted)">
                  Agent Output Summary:
                </span>
                <div className="mt-2">
                  <MarkdownRenderer content={step.reportStatus} />
                </div>
              </div>
            )}
          </div>
        </TabPanel>

        {/* INSTRUCTION SENT TAB */}
        <TabPanel active={activeTab === 'packet'}>
          {loading ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : packet !== null ? (
            <div className="space-y-4">
              <div>
                <span className="text-[11px] font-semibold text-(--color-text-muted)">
                  Objective:
                </span>
                <div className="mt-1 rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-3">
                  <MarkdownRenderer content={packet.objective} />
                </div>
              </div>

              {packet.constraints.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">
                    Constraints & Rules:
                  </span>
                  <ul className="mt-1 list-disc pl-4 text-[12px] text-(--color-text-muted)">
                    {packet.constraints.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {packet.allowedPaths.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">
                    Allowed Scope Paths:
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {packet.allowedPaths.map((p) => (
                      <Badge key={p} tone="neutral" size="sm" className="font-mono">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {packet.completionCriteria.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">
                    Completion & Verification Criteria:
                  </span>
                  <ul className="mt-1 list-disc pl-4 text-[12px] text-(--color-text-muted)">
                    {packet.completionCriteria.map((cr) => (
                      <li key={cr}>{cr}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-(--color-text-muted)">
              No prompt packet captured for this step. Packets are compiled when the step starts.
            </p>
          )}
        </TabPanel>

        {/* VERDICT & EVIDENCE TAB */}
        <TabPanel active={activeTab === 'verdict'}>
          <div className="space-y-3">
            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">Verdict:</span>
              <p className="mt-1 font-mono text-[14px] font-bold uppercase text-(--color-text)">
                {step.verdict ?? 'No verdict reached yet'}
              </p>
            </div>
            {step.changeSetId !== null && (
              <div>
                <span className="text-[11px] font-semibold text-(--color-text-muted)">
                  Recorded ChangeSet:
                </span>
                <p className="font-mono text-[12px] text-(--color-text-muted)">
                  {step.changeSetId}
                </p>
              </div>
            )}
          </div>
        </TabPanel>
      </div>
    </div>
  )
}

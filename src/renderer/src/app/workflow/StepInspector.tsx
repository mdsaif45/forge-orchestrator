import React, { useEffect, useState } from 'react'
import type { PromptPacketView, WorkflowStepView } from '@shared/ipc'
import { Badge, Spinner, TabPanel, Tabs } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'

export interface StepInspectorProps {
  readonly step: WorkflowStepView | null
  readonly onClose?: () => void
}

type StepTab = 'summary' | 'packet' | 'verdict'

const TAB_ITEMS: readonly { readonly value: StepTab; readonly label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'packet', label: 'Prompt Packet' },
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
        Click a node in the workflow graph to inspect its details, prompt packet, and verdict.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-(--color-border) bg-(--color-surface-raised) text-[13px] shadow-xs">
      {/* Step Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised)/80 p-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase text-(--color-text)">{step.role}</span>
          <Badge
            tone={
              step.state === 'completed' ? 'success' : step.state === 'running' ? 'info' : 'neutral'
            }
          >
            {step.state}
          </Badge>
          {step.verdict !== null && (
            <Badge
              tone={
                step.verdict === 'pass' ? 'success' : step.verdict === 'fail' ? 'danger' : 'neutral'
              }
            >
              {step.verdict}
            </Badge>
          )}
        </div>

        {onClose !== undefined && (
          <button
            type="button"
            onClick={() => {
              onClose()
            }}
            className="text-[12px] text-(--color-text-muted) hover:text-(--color-text) cursor-pointer"
          >
            ✕ Close
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-(--color-border) px-3 pt-2">
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
        <TabPanel active={activeTab === 'summary'}>
          <div className="space-y-3">
            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">Step Index:</span>
              <p className="font-mono text-(--color-text)">{step.index}</p>
            </div>
            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">Runtime:</span>
              <p className="font-mono text-(--color-text)">
                {step.runtimeId ?? 'system / Forge internal'}
              </p>
            </div>
            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">Timing:</span>
              <p className="text-[12px] text-(--color-text-muted)">
                Started: {step.startedAt ?? 'Pending'} <br />
                Finished: {step.finishedAt ?? 'In progress'}
              </p>
            </div>
            {step.reportStatus !== null && (
              <div>
                <span className="text-[11px] font-semibold text-(--color-text-muted)">Report Status:</span>
                <p className="font-mono text-[12px] text-(--color-text)">{step.reportStatus}</p>
              </div>
            )}
          </div>
        </TabPanel>

        <TabPanel active={activeTab === 'packet'}>
          {loading ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : packet !== null ? (
            <div className="space-y-4">
              <div>
                <span className="text-[11px] font-semibold text-(--color-text-muted)">Objective:</span>
                <p className="mt-1 text-[13px] text-(--color-text)">{packet.objective}</p>
              </div>

              {packet.constraints.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">Constraints:</span>
                  <ul className="mt-1 list-disc pl-4 text-[12px] text-(--color-text-muted)">
                    {packet.constraints.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {packet.allowedPaths.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">Allowed Paths:</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {packet.allowedPaths.map((p) => (
                      <Badge key={p} tone="neutral">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {packet.completionCriteria.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold text-(--color-text-muted)">
                    Completion Criteria:
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
            <p className="text-[12px] text-(--color-text-muted)">No prompt packet recorded for this step.</p>
          )}
        </TabPanel>

        <TabPanel active={activeTab === 'verdict'}>
          <div className="space-y-3">
            <div>
              <span className="text-[11px] font-semibold text-(--color-text-muted)">Verdict:</span>
              <p className="mt-1 font-mono text-[13px] uppercase text-(--color-text)">
                {step.verdict ?? 'No verdict reached yet'}
              </p>
            </div>
            {step.changeSetId !== null && (
              <div>
                <span className="text-[11px] font-semibold text-(--color-text-muted)">ChangeSet ID:</span>
                <p className="font-mono text-[12px] text-(--color-text-muted)">{step.changeSetId}</p>
              </div>
            )}
          </div>
        </TabPanel>
      </div>
    </div>
  )
}

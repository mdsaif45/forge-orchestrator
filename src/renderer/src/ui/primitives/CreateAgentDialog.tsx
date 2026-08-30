import React, { useState } from 'react'
import { Button } from './Button'
import { Checkbox } from './Checkbox'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input, Textarea } from './Input'
import { Select } from './Select'

export interface CustomAgentConfig {
  readonly id: string
  readonly name: string
  readonly roleType: 'planner' | 'implementer' | 'reviewer' | 'custom'
  readonly instructions: string
  readonly runtimeId: string
  readonly capabilities: readonly string[]
  readonly avatarColor?: string | undefined
}

export interface CreateAgentDialogProps {
  readonly open: boolean
  readonly availableRuntimes: readonly { readonly id: string; readonly label: string }[]
  readonly onClose: () => void
  readonly onSave: (agent: CustomAgentConfig) => void
}

const ALL_CAPABILITIES = [
  { id: 'repo-read', label: 'Read Repository Files & History' },
  { id: 'plan', label: 'Produce Architectural Plans & Decisions' },
  { id: 'file-write', label: 'Modify & Create Source Files' },
  { id: 'test', label: 'Execute Build & Test Suites' },
  { id: 'review', label: 'Conduct Automated Code Review' },
  { id: 'terminal', label: 'Run Permitted Terminal Commands' },
]

export function CreateAgentDialog({
  open,
  availableRuntimes,
  onClose,
  onSave,
}: CreateAgentDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [roleType, setRoleType] = useState<'planner' | 'implementer' | 'reviewer' | 'custom'>('planner')
  const [runtimeId, setRuntimeId] = useState(availableRuntimes[0]?.id ?? 'mock:default')
  const [instructions, setInstructions] = useState('')
  const [capabilities, setCapabilities] = useState<readonly string[]>([
    'repo-read',
    'plan',
    'file-write',
    'test',
    'review',
    'terminal',
  ])

  const isValid = name.trim() !== '' && runtimeId.trim() !== ''

  const toggleCapability = (capId: string): void => {
    if (capabilities.includes(capId)) {
      setCapabilities(capabilities.filter((c) => c !== capId))
    } else {
      setCapabilities([...capabilities, capId])
    }
  }

  const handleSave = (): void => {
    if (!isValid) return
    onSave({
      id: `agent-${Date.now().toString()}`,
      name: name.trim(),
      roleType,
      runtimeId,
      instructions: instructions.trim(),
      capabilities,
    })
    onClose()
    setName('')
    setInstructions('')
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create Custom AI Agent"
      description="Define a specialized agent persona, custom directives, and execution capabilities."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleSave}>
            Save Agent
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Agent Name */}
          <Field label="Agent Name" required>
            {() => (
              <Input
                placeholder="e.g. Senior Security Auditor"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setName(e.target.value)
                }}
                autoFocus
              />
            )}
          </Field>

          {/* Primary Pipeline Role */}
          <Field label="Primary Role" required>
            {() => (
              <Select
                value={roleType}
                onChange={(e: { target: { value: string } }) => {
                  setRoleType(e.target.value as 'planner' | 'implementer' | 'reviewer' | 'custom')
                }}
                options={[
                  { value: 'planner', label: 'Planner (Architectural Design)' },
                  { value: 'implementer', label: 'Implementer (Code Execution)' },
                  { value: 'reviewer', label: 'Reviewer (Quality & Verification)' },
                  { value: 'custom', label: 'Specialist / Multi-purpose' },
                ]}
              />
            )}
          </Field>
        </div>

        {/* Runtime / Model Selection */}
        <Field label="Execution Runtime / Model Engine" required>
          {() => (
            <Select
              value={runtimeId}
              onChange={(e: { target: { value: string } }) => {
                setRuntimeId(e.target.value)
              }}
              options={availableRuntimes.map((r) => ({
                value: r.id,
                label: r.label,
              }))}
            />
          )}
        </Field>

        {/* System Directives */}
        <Field
          label="Custom Persona & System Directives"
          hint="Specific instructions that govern this agent's coding style, security boundaries, and decisions"
        >
          {() => (
            <Textarea
              placeholder="e.g. Enforce strict defensive coding patterns, prioritize clean unit tests, verify edge cases before finalizing code, and write detailed architectural explanations..."
              value={instructions}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setInstructions(e.target.value)
              }}
              rows={4}
              className="text-[12px] font-mono leading-relaxed"
            />
          )}
        </Field>

        {/* Capabilities Checklist */}
        <div className="space-y-2 pt-1">
          <label className="font-semibold text-(--color-text)">Granted Capabilities</label>
          <div className="grid grid-cols-1 gap-2 rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3 sm:grid-cols-2">
            {ALL_CAPABILITIES.map((cap) => (
              <Checkbox
                key={cap.id}
                label={cap.label}
                checked={capabilities.includes(cap.id)}
                onChange={() => {
                  toggleCapability(cap.id)
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

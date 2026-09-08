import React, { useState } from 'react'
import type { WorkflowTemplateView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card } from './Card'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input, Textarea } from './Input'
import { Select } from './Select'

export interface CreateTemplateDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onSave: (template: WorkflowTemplateView) => void
}

interface StepDraft {
  readonly id: string
  role: string
  label: string
  advanceTrigger: string
  performedByForge: boolean
}

const DEFAULT_ROLES = [
  { value: 'planner', label: 'Planner (Agent - Read-only Analysis)' },
  { value: 'user', label: 'User Gate (Human Review & Approval)' },
  { value: 'implementer', label: 'Implementer (Agent - Code Writing)' },
  { value: 'system', label: 'System (Forge Verification & Diff)' },
  { value: 'reviewer', label: 'Reviewer (Agent - Quality Audit)' },
]

export function CreateTemplateDialog({
  open,
  onClose,
  onSave,
}: CreateTemplateDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<readonly StepDraft[]>([
    {
      id: 'step-1',
      role: 'planner',
      label: 'Analyze & Plan',
      advanceTrigger: 'planProduced',
      performedByForge: false,
    },
    {
      id: 'step-2',
      role: 'user',
      label: 'Approve Plan',
      advanceTrigger: 'approved',
      performedByForge: false,
    },
    {
      id: 'step-3',
      role: 'implementer',
      label: 'Implement Changes',
      advanceTrigger: 'stepCompleted',
      performedByForge: false,
    },
    {
      id: 'step-4',
      role: 'system',
      label: 'Verify Changes',
      advanceTrigger: 'verified',
      performedByForge: true,
    },
    {
      id: 'step-5',
      role: 'reviewer',
      label: 'Review Code',
      advanceTrigger: 'reviewed',
      performedByForge: false,
    },
  ])

  const isValid = name.trim() !== '' && description.trim() !== '' && steps.length >= 2

  const handleAddStep = (): void => {
    const newStep: StepDraft = {
      id: `step-${Date.now().toString()}`,
      role: 'implementer',
      label: 'Custom Step',
      advanceTrigger: 'stepCompleted',
      performedByForge: false,
    }
    setSteps([...steps, newStep])
  }

  const handleRemoveStep = (index: number): void => {
    if (steps.length <= 2) return
    setSteps(steps.filter((_, i) => i !== index))
  }

  const handleMoveStep = (index: number, direction: 'up' | 'down'): void => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= steps.length) return
    const next = [...steps]
    const [moved] = next.splice(index, 1)
    if (moved) {
      next.splice(targetIndex, 0, moved)
      setSteps(next)
    }
  }

  const handleUpdateStep = (index: number, updates: Partial<StepDraft>): void => {
    setSteps(
      steps.map((s, i) => {
        if (i !== index) return s
        const updated = { ...s, ...updates }
        if (updates.role === 'system') {
          updated.performedByForge = true
          updated.advanceTrigger = 'verified'
        } else if (updates.role === 'user') {
          updated.performedByForge = false
          updated.advanceTrigger = 'approved'
        } else if (updates.role === 'planner') {
          updated.performedByForge = false
          updated.advanceTrigger = 'planProduced'
        }
        return updated
      }),
    )
  }

  const handleSave = (): void => {
    if (!isValid) return
    const templateId = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-4)}`
    onSave({
      id: templateId,
      name: name.trim(),
      description: description.trim(),
      steps: steps.map((s) => ({
        role: s.role,
        label: s.label,
        advanceTrigger: s.advanceTrigger,
        performedByForge: s.performedByForge,
      })),
    })
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create Custom Workflow Template"
      description="Design a custom multi-step agent pipeline tailored to your project's engineering workflow."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleSave}>
            Save Template
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        {/* Template Name & Description */}
        <Field label="Template Name" required>
          {() => (
            <Input
              placeholder="e.g. Test-Driven Feature Implementation"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setName(e.target.value)
              }}
              autoFocus
            />
          )}
        </Field>

        <Field label="Description" required>
          {() => (
            <Textarea
              placeholder="Describe what this workflow accomplishes and its execution sequence..."
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setDescription(e.target.value)
              }}
              rows={2}
            />
          )}
        </Field>

        {/* Step Sequence Builder */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <label className="font-semibold text-(--color-text)">
              Pipeline Stages ({steps.length})
            </label>
            <Button size="sm" variant="secondary" onClick={handleAddStep} className="text-[11px]">
              + Add Stage
            </Button>
          </div>

          <div className="space-y-2">
            {steps.map((step, idx) => (
              <Card key={step.id} tone="raised" className="p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-(--color-surface-inset) font-mono text-[11px] font-bold text-(--color-text-muted)">
                    {idx + 1}
                  </span>

                  <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      placeholder="Step Label (e.g. Plan, Implement)"
                      value={step.label}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        handleUpdateStep(idx, { label: e.target.value })
                      }}
                      className="h-8 text-[12px]"
                    />

                    <Select
                      value={step.role}
                      onChange={(e: { target: { value: string } }) => {
                        handleUpdateStep(idx, { role: e.target.value })
                      }}
                      options={DEFAULT_ROLES}
                    />
                  </div>

                  {/* Move Up / Down / Remove Controls */}
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={idx === 0}
                      onClick={() => {
                        handleMoveStep(idx, 'up')
                      }}
                      className="h-7 w-7 p-0"
                      title="Move up"
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={idx === steps.length - 1}
                      onClick={() => {
                        handleMoveStep(idx, 'down')
                      }}
                      className="h-7 w-7 p-0"
                      title="Move down"
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={steps.length <= 2}
                      onClick={() => {
                        handleRemoveStep(idx)
                      }}
                      className="h-7 w-7 p-0 text-(--color-danger) hover:text-(--color-danger)"
                      title="Remove stage"
                    >
                      ✕
                    </Button>
                  </div>
                </div>

                <div className="mt-1.5 flex items-center gap-2 pl-7 text-[11px] text-(--color-text-muted)">
                  <Badge tone="neutral" size="sm">
                    {step.role === 'system'
                      ? 'Automated Forge Gate'
                      : step.role === 'user'
                        ? 'Human Approval Required'
                        : 'Agent Execution'}
                  </Badge>
                  <span className="font-mono text-[10px]">trigger: {step.advanceTrigger}</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

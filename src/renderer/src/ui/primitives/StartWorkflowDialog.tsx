import React, { useState } from 'react'
import type { WorkflowTemplateView } from '@shared/ipc'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input, Textarea } from './Input'
import { Select } from './Select'

export interface StartWorkflowDialogProps {
  readonly open: boolean
  readonly templates: readonly WorkflowTemplateView[]
  readonly selectedTemplateId: string
  readonly onSelectTemplate: (templateId: string) => void
  readonly onCreateCustomTemplate?: (() => void) | undefined
  readonly onClose: () => void
  readonly onStart: (data: {
    readonly templateId: string
    readonly title: string
    readonly objective: string
    readonly scopePaths?: readonly string[] | undefined
  }) => Promise<void> | void
}

export function StartWorkflowDialog({
  open,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onCreateCustomTemplate,
  onClose,
  onStart,
}: StartWorkflowDialogProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [scopeInput, setScopeInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isValid = title.trim() !== '' && objective.trim() !== ''

  const handleStart = async (): Promise<void> => {
    if (!isValid || submitting) return
    setSubmitting(true)
    try {
      const scopePaths = scopeInput
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      await onStart({
        templateId: selectedTemplateId,
        title: title.trim(),
        objective: `${title.trim()}\n\nRequirements:\n${objective.trim()}`,
        scopePaths: scopePaths.length > 0 ? scopePaths : undefined,
      })
      onClose()
      setTitle('')
      setObjective('')
      setScopeInput('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start New Work"
      description="Define task requirements and objectives for your agents to plan and execute in sandbox."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!isValid || submitting}
            onClick={() => {
              void handleStart()
            }}
          >
            {submitting ? 'Initiating Sandbox...' : 'Start Planning & Implementation'}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        {/* Workflow Template Selector with Create Template Action */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="font-semibold text-(--color-text)">Workflow Template *</label>
            {onCreateCustomTemplate && (
              <button
                type="button"
                onClick={onCreateCustomTemplate}
                className="text-[11px] font-medium text-(--color-accent) hover:underline cursor-pointer"
              >
                + Create Custom Template
              </button>
            )}
          </div>
          <Select
            value={selectedTemplateId}
            onChange={(e: { target: { value: string } }) => {
              onSelectTemplate(e.target.value)
            }}
            options={templates.map((t) => ({
              value: t.id,
              label: `${t.name} — ${t.description}`,
            }))}
          />
        </div>

        {/* Work / Task Title */}
        <Field label="Work / Task Title" required hint="Short, descriptive headline for this task">
          {() => (
            <Input
              placeholder="e.g. Add dark mode toggle with persistent state"
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setTitle(e.target.value)
              }}
              autoFocus
              className="text-[13px]"
            />
          )}
        </Field>

        {/* Detailed Requirements Textarea */}
        <Field
          label="Feature Requirements & Details"
          required
          hint="Describe what needs to be built, user expectations, and any specific constraints"
        >
          {() => (
            <Textarea
              placeholder="Describe the requirements in detail:&#10;- Add a toggle switch in the user settings&#10;- Use CSS variables and localStorage for persistence&#10;- Ensure smooth transitions between themes"
              value={objective}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setObjective(e.target.value)
              }}
              rows={8}
              className="min-h-[160px] text-[12px] font-mono leading-relaxed resize-y"
            />
          )}
        </Field>

        {/* Target Files / Scope (Optional) */}
        <Field
          label="Scope / Target Files (Optional)"
          hint="Comma-separated file paths or directories to focus on (leave blank for whole repository)"
        >
          {() => (
            <Input
              placeholder="e.g. src/renderer/src/ui, src/renderer/src/app/theme.ts"
              value={scopeInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setScopeInput(e.target.value)
              }}
              className="text-[12px]"
            />
          )}
        </Field>
      </div>
    </Dialog>
  )
}

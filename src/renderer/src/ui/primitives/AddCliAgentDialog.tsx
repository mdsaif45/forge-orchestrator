import React, { useState } from 'react'
import { Button } from './Button'
import { Checkbox } from './Checkbox'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input, Textarea } from './Input'
import { Select } from './Select'

export interface CliAgentConfig {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly permissionMode: 'developer' | 'ask' | 'headless'
  readonly argsTemplate?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly isBuiltin?: boolean | undefined
  readonly status: 'ready' | 'detected' | 'not_found' | 'configured'
}

export interface AddCliAgentDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onSave: (config: CliAgentConfig) => void
}

const ALL_CAPABILITIES = [
  { id: 'repo-read', label: 'Repository Read (Explore AST & Search)' },
  { id: 'file-write', label: 'File Write (Sandbox Code Modifications)' },
  { id: 'terminal', label: 'Terminal Execution (Build & Test Suites)' },
  { id: 'plan', label: 'Architecture Planning (Decision Proposals)' },
  { id: 'review', label: 'Security & Quality Review (Diff Audits)' },
] as const

/**
 * Dialog for adding and configuring custom CLI Agent runtimes.
 */
export function AddCliAgentDialog({
  open,
  onClose,
  onSave,
}: AddCliAgentDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [description, setDescription] = useState('')
  const [permissionMode, setPermissionMode] = useState<'developer' | 'ask' | 'headless'>(
    'developer',
  )
  const [argsTemplate, setArgsTemplate] = useState('--output json')
  const [selectedCapabilities, setSelectedCapabilities] = useState<readonly string[]>([
    'repo-read',
    'file-write',
    'terminal',
  ])
  const [envString, setEnvString] = useState('')

  const isValid = name.trim() !== '' && command.trim() !== ''

  const toggleCapability = (capId: string): void => {
    setSelectedCapabilities((prev) =>
      prev.includes(capId) ? prev.filter((c) => c !== capId) : [...prev, capId],
    )
  }

  const handleSave = (): void => {
    if (!isValid) return

    // Parse environment variables
    const parsedEnv: Record<string, string> = {}
    if (envString.trim() !== '') {
      for (const line of envString.split('\n')) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#')) {
          const idx = trimmed.indexOf('=')
          if (idx > 0) {
            const k = trimmed.slice(0, idx).trim()
            const v = trimmed.slice(idx + 1).trim()
            parsedEnv[k] = v
          }
        }
      }
    }

    onSave({
      id: `cli-${Date.now().toString()}`,
      name: name.trim(),
      command: command.trim(),
      description: description.trim() || 'Custom CLI Agent runtime',
      capabilities: selectedCapabilities,
      permissionMode,
      argsTemplate: argsTemplate.trim() || undefined,
      env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      isBuiltin: false,
      status: 'configured',
    })

    // Reset
    setName('')
    setCommand('')
    setDescription('')
    setArgsTemplate('--output json')
    setEnvString('')
    setSelectedCapabilities(['repo-read', 'file-write', 'terminal'])
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add CLI Agent Runtime"
      description="Connect an autonomous coding CLI tool to execute workflow pipeline stages inside sandboxed worktrees."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleSave}>
            Save CLI Agent
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Agent Name" required hint="e.g. OpenCode CLI, Aider, Devin CLI">
            {() => (
              <Input
                placeholder="OpenCode CLI"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setName(e.target.value)
                }}
                autoFocus
              />
            )}
          </Field>

          <Field
            label="Executable Command / Path"
            required
            hint="e.g. opencode, aider, path/to/bin"
          >
            {() => (
              <Input
                placeholder="opencode"
                value={command}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setCommand(e.target.value)
                }}
                className="font-mono"
              />
            )}
          </Field>
        </div>

        <Field label="Description" hint="Brief summary of this CLI agent runtime">
          {() => (
            <Input
              placeholder="Open-source agentic coding assistant with terminal execution support"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setDescription(e.target.value)
              }}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Permission Mode" hint="How tool executions are authorized">
            {() => (
              <Select
                value={permissionMode}
                onChange={(e: { target: { value: string } }) => {
                  setPermissionMode(e.target.value as 'developer' | 'ask' | 'headless')
                }}
                options={[
                  { value: 'developer', label: 'Developer (Autonomous Sandbox)' },
                  { value: 'ask', label: 'Interactive Confirmation' },
                  { value: 'headless', label: 'Headless (Non-interactive)' },
                ]}
              />
            )}
          </Field>

          <Field label="Arguments Template" hint="Flags passed when spawning this CLI agent">
            {() => (
              <Input
                placeholder="--output json --yes"
                value={argsTemplate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setArgsTemplate(e.target.value)
                }}
                className="font-mono"
              />
            )}
          </Field>
        </div>

        {/* Capabilities Selection */}
        <div>
          <label className="block text-[11px] font-semibold text-(--color-text) mb-2">
            Granted Capabilities
          </label>
          <div className="space-y-2 rounded-xl bg-(--color-surface-inset) border border-(--color-border) p-3">
            {ALL_CAPABILITIES.map((cap) => {
              const isChecked = selectedCapabilities.includes(cap.id)
              return (
                <Checkbox
                  key={cap.id}
                  label={cap.id}
                  hint={cap.label}
                  checked={isChecked}
                  onChange={() => {
                    toggleCapability(cap.id)
                  }}
                />
              )
            })}
          </div>
        </div>

        <Field
          label="Environment Variables"
          hint="KEY=VALUE pairs passed to the spawned CLI process (one per line)"
        >
          {() => (
            <Textarea
              placeholder={`OPENCODE_API_KEY=sk_12345\nLOG_LEVEL=info`}
              value={envString}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setEnvString(e.target.value)
              }}
              rows={2}
              className="font-mono text-[11px]"
            />
          )}
        </Field>
      </div>
    </Dialog>
  )
}

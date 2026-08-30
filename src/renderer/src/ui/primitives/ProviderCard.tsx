import { useState } from 'react'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'
import { Select } from './Select'
import { StatusDot } from './StatusDot'

export interface ProviderCardProps {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly apiKey?: string | undefined
  readonly envVarHint?: string | undefined
  readonly isConfigured: boolean
  readonly isActive: boolean
  readonly type: 'api_key' | 'local' | 'custom'
  readonly localUrl?: string | undefined
  readonly models?: readonly string[] | undefined
  readonly activeModel?: string | undefined
  readonly onSaveKey?: ((key: string) => void) | undefined
  readonly onResetKey?: (() => void) | undefined
  readonly onSetActive?: (() => void) | undefined
  readonly onConfigure?: (() => void) | undefined
  readonly onSelectModel?: ((model: string) => void) | undefined
  readonly onDelete?: (() => void) | undefined
}

/**
 * Clean and modern LLM Provider card component.
 * Displays provider credentials, active status, and model configuration.
 */
export function ProviderCard({
  name,
  description,
  apiKey = '',
  envVarHint,
  isConfigured,
  isActive,
  type,
  localUrl,
  models = [],
  activeModel,
  onSaveKey,
  onResetKey,
  onSetActive,
  onConfigure,
  onSelectModel,
  onDelete,
}: ProviderCardProps): React.JSX.Element {
  const [editingKey, setEditingKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')

  const handleSave = (): void => {
    if (keyInput.trim() !== '') {
      onSaveKey?.(keyInput.trim())
      setKeyInput('')
      setEditingKey(false)
    }
  }

  const effectiveApiKey = apiKey

  return (
    <Card
      tone="raised"
      className={`p-4 transition-all ${
        isActive ? 'border-(--color-accent)/40 shadow-xs' : 'border-(--color-border)'
      }`}
    >
      <div className="flex flex-col gap-3">
        {/* Header Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-[14px] font-bold tracking-tight text-(--color-text)">
              {name}
            </span>
            {isActive ? (
              <Badge tone="accent" size="sm" className="font-semibold">
                Active Provider
              </Badge>
            ) : isConfigured ? (
              <Badge tone="neutral" size="sm">
                Configured
              </Badge>
            ) : (
              <Badge tone="warning" size="sm">
                Not configured
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isActive && isConfigured && (
              <Button size="sm" variant="secondary" onClick={onSetActive} className="text-[11px]">
                Use Provider
              </Button>
            )}
            {onDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                className="text-[11px] text-(--color-danger) hover:text-(--color-danger)"
              >
                Remove
              </Button>
            )}
          </div>
        </div>

        {/* Description & Env hint */}
        <div className="text-[12px] text-(--color-text-muted)">
          <p className="m-0 leading-relaxed">{description}</p>
          {envVarHint && !isConfigured && (
            <p className="m-0 mt-0.5 text-[11px] text-(--color-text-subtle)">
              Or set the <code className="font-mono text-(--color-text)">{envVarHint}</code> env var.
            </p>
          )}
        </div>

        {/* Action Controls based on Type */}
        {type === 'api_key' || type === 'custom' ? (
          <div className="mt-1 flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
            {isConfigured && !editingKey ? (
              <div className="flex flex-1 items-center justify-between rounded-lg border border-(--color-border) bg-(--color-surface-inset) px-3 py-1.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <StatusDot status="passed" label="Configured" />
                  <span className="font-mono text-(--color-text-muted)">
                    {effectiveApiKey.length > 8 ? `••••••••••••${effectiveApiKey.slice(-4)}` : '••••••••••••••••'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingKey(true)
                    }}
                    className="text-[11px] font-medium text-(--color-accent) hover:underline cursor-pointer"
                  >
                    Edit
                  </button>
                  {onResetKey && (
                    <button
                      type="button"
                      onClick={onResetKey}
                      className="text-[11px] font-medium text-(--color-text-muted) hover:text-(--color-danger) cursor-pointer"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <Input
                  type="password"
                  placeholder="Enter API Key (e.g. sk-...)"
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value)
                  }}
                  className="h-8 text-[12px] font-mono"
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={keyInput.trim() === ''}
                  onClick={handleSave}
                  className="h-8 text-[12px]"
                >
                  Save Key
                </Button>
                {editingKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingKey(false)
                    }}
                    className="h-8 text-[12px]"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}

            {/* Model Selector if multiple models are available */}
            {models.length > 0 && isConfigured && (
              <div className="w-48 shrink-0">
                <Select
                  value={activeModel ?? models[0] ?? ''}
                  onChange={(e) => {
                    onSelectModel?.(e.target.value)
                  }}
                  options={models.map((m) => ({ value: m, label: m }))}
                />
              </div>
            )}
          </div>
        ) : (
          /* Local Endpoint */
          <div className="mt-1 flex items-center justify-between rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-3 text-[12px]">
            <div className="space-y-0.5">
              <p className="m-0 font-medium text-(--color-text)">Local Endpoint</p>
              <p className="m-0 font-mono text-[11px] text-(--color-text-muted)">
                {localUrl ?? 'http://localhost:11434'}
              </p>
            </div>
            {onConfigure && (
              <Button size="sm" variant="secondary" onClick={onConfigure} className="text-[12px]">
                Configure ›
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

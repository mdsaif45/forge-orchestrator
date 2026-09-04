import React, { useState } from 'react'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'
import { Select } from './Select'
import { Spinner } from './Spinner'
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
  readonly onSaveLocalUrl?: ((url: string, detectedModels?: readonly string[]) => void) | undefined
  readonly onSetActive?: (() => void) | undefined
  readonly onConfigure?: (() => void) | undefined
  readonly onSelectModel?: ((model: string) => void) | undefined
  readonly onDelete?: (() => void) | undefined
}

/**
 * Clean and modern LLM Provider card component.
 * Displays provider credentials, active status, local endpoint scanning, and model selection.
 */
export function ProviderCard({
  id,
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
  onSaveLocalUrl,
  onSetActive,
  onSelectModel,
  onDelete,
}: ProviderCardProps): React.JSX.Element {
  const [editingKey, setEditingKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')

  // Local endpoint scanning states
  const defaultUrl =
    localUrl ?? (id === 'lmstudio' ? 'http://localhost:1234/v1' : 'http://localhost:11434')
  const [endpointInput, setEndpointInput] = useState(defaultUrl)
  const [isScanning, setIsScanning] = useState(false)
  const [scanResult, setScanResult] = useState<{
    status: 'idle' | 'success' | 'warning'
    message: string
  }>({ status: 'idle', message: '' })

  const handleSaveKey = (): void => {
    if (keyInput.trim() !== '') {
      onSaveKey?.(keyInput.trim())
      setKeyInput('')
      setEditingKey(false)
    }
  }

  const handleScanModels = async (): Promise<void> => {
    const targetUrl = endpointInput.trim() || defaultUrl
    setIsScanning(true)
    setScanResult({ status: 'idle', message: '' })

    try {
      const res = await window.forge.provider.scanModels(id, targetUrl)
      if (res.ok && res.value.ok && res.value.models.length > 0) {
        setScanResult({
          status: 'success',
          message: `Connected to ${targetUrl}. Discovered ${String(res.value.models.length)} model(s).`,
        })
        onSaveLocalUrl?.(targetUrl, res.value.models)
      } else {
        const errorMsg =
          (res.ok ? res.value.error : null) ??
          `Could not connect to ${targetUrl}. Is the service running?`
        setScanResult({
          status: 'warning',
          message: errorMsg,
        })
        onSaveLocalUrl?.(targetUrl, [])
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : `Failed to connect to ${targetUrl}`
      setScanResult({
        status: 'warning',
        message: errorMsg,
      })
      onSaveLocalUrl?.(targetUrl, [])
    } finally {
      setIsScanning(false)
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
            <span className="text-[14px] font-bold tracking-tight text-(--color-text)">{name}</span>
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
              Or set the <code className="font-mono text-(--color-text)">{envVarHint}</code> env
              var.
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
                    {effectiveApiKey.length > 8
                      ? `••••••••••••${effectiveApiKey.slice(-4)}`
                      : '••••••••••••••••'}
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
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setKeyInput(e.target.value)
                  }}
                  className="h-8 text-[12px] font-mono"
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={keyInput.trim() === ''}
                  onClick={handleSaveKey}
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
              <div className="w-52 shrink-0">
                <Select
                  value={activeModel ?? models[0] ?? ''}
                  onChange={(e: { target: { value: string } }) => {
                    onSelectModel?.(e.target.value)
                  }}
                  options={models.map((m) => ({ value: m, label: m }))}
                />
              </div>
            )}
          </div>
        ) : (
          /* Local Endpoint with Model Discovery & Verification */
          <div className="mt-1 rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-3.5 text-[12px] space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle) mb-1.5">
                  Local Endpoint URL
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder={defaultUrl}
                    value={endpointInput}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setEndpointInput(e.target.value)
                    }}
                    className="h-8 text-[12px] font-mono flex-1"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isScanning}
                    onClick={() => {
                      void handleScanModels()
                    }}
                    className="h-8 text-[11px] shrink-0"
                  >
                    {isScanning ? (
                      <span className="flex items-center gap-1">
                        <Spinner size="sm" />
                        Scanning...
                      </span>
                    ) : (
                      'Verify & Scan Models'
                    )}
                  </Button>
                </div>
              </div>

              {/* Active Model Selector */}
              {models.length > 0 && (
                <div className="w-56 shrink-0">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle) mb-1.5">
                    Active Model
                  </label>
                  <Select
                    value={activeModel ?? models[0] ?? ''}
                    onChange={(e: { target: { value: string } }) => {
                      onSelectModel?.(e.target.value)
                    }}
                    options={models.map((m) => ({ value: m, label: m }))}
                  />
                </div>
              )}
            </div>

            {/* Scan Status Feedback */}
            {scanResult.message && (
              <div
                className={`flex items-center gap-1.5 text-[11px] font-medium ${
                  scanResult.status === 'success'
                    ? 'text-(--color-success)'
                    : 'text-(--color-warning)'
                }`}
              >
                <span>{scanResult.status === 'success' ? '✓' : 'ℹ'}</span>
                <span>{scanResult.message}</span>
              </div>
            )}

            {/* Installed / Detected Model Pills List */}
            {models.length > 0 && (
              <div className="pt-2 border-t border-(--color-border)/50">
                <span className="text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) block mb-2">
                  Installed / Detected Models ({models.length}):
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {models.map((m) => {
                    const isCurrent = m === activeModel
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          onSelectModel?.(m)
                        }}
                        className={`rounded-md px-2.5 py-1 font-mono text-[11px] cursor-pointer transition-colors border select-none ${
                          isCurrent
                            ? 'bg-(--color-accent)/15 border-(--color-accent)/40 text-(--color-accent) font-semibold shadow-xs'
                            : 'bg-(--color-surface-raised) border-(--color-border) text-(--color-text-muted) hover:text-(--color-text) hover:border-(--color-border-strong)'
                        }`}
                        title={isCurrent ? 'Current active model' : 'Click to select this model'}
                      >
                        {m} {isCurrent && '✓'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

import { useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input } from './Input'
import { Select } from './Select'

export interface CustomProviderConfig {
  readonly id: string
  readonly name: string
  readonly apiType: 'openai' | 'messages'
  readonly apiUrl: string
  readonly apiKey: string
  readonly modelName: string
  readonly maxOutputTokens: number
  readonly maxTokens: number
  readonly supportsTools: boolean
  readonly supportsImages: boolean
  readonly supportsThinking: boolean
}

export interface AddProviderDialogProps {
  readonly open: boolean
  readonly initialType?: 'openai' | 'messages'
  readonly onClose: () => void
  readonly onSave: (config: CustomProviderConfig) => void
}

/**
 * Dialog for configuring and adding custom LLM providers and models.
 */
export function AddProviderDialog({
  open,
  initialType = 'openai',
  onClose,
  onSave,
}: AddProviderDialogProps): React.JSX.Element {
  const [apiType, setApiType] = useState<'openai' | 'messages'>(initialType)
  const [name, setName] = useState('')
  const [apiUrl, setApiUrl] = useState(
    initialType === 'openai' ? 'https://api.openai.com/v1' : 'https://api.messages-endpoint.com/v1',
  )
  const [apiKey, setApiKey] = useState('')
  const [modelName, setModelName] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState('32000')
  const [maxTokens, setMaxTokens] = useState('128000')
  const [supportsTools, setSupportsTools] = useState(true)
  const [supportsImages, setSupportsImages] = useState(false)
  const [supportsThinking, setSupportsThinking] = useState(false)

  const isValid = name.trim() !== '' && apiUrl.trim() !== '' && modelName.trim() !== ''

  const handleSave = (): void => {
    if (!isValid) return
    onSave({
      id: `custom-${Date.now().toString()}`,
      name: name.trim(),
      apiType,
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      modelName: modelName.trim(),
      maxOutputTokens: parseInt(maxOutputTokens, 10) || 32000,
      maxTokens: parseInt(maxTokens, 10) || 128000,
      supportsTools,
      supportsImages,
      supportsThinking,
    })
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        apiType === 'openai' ? 'Add OpenAI-Compatible Provider' : 'Add Messages-Compatible Provider'
      }
      description="Configure a custom API endpoint, key, and model parameters for agent execution."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleSave}>
            Save Provider
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Provider Format" required>
            {() => (
              <Select
                value={apiType}
                onChange={(e) => {
                  const next = e.target.value as 'openai' | 'messages'
                  setApiType(next)
                  if (next === 'openai') {
                    setApiUrl('https://api.openai.com/v1')
                  } else {
                    setApiUrl('https://api.messages-endpoint.com/v1')
                  }
                }}
                options={[
                  { value: 'openai', label: 'OpenAI-Compatible API' },
                  { value: 'messages', label: 'Messages-Compatible API' },
                ]}
              />
            )}
          </Field>

          <Field label="Provider Name" required hint="A unique display name">
            {(bind) => (
              <Input
                {...bind}
                placeholder="e.g. Groq, Together AI, Local vLLM"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                }}
              />
            )}
          </Field>
        </div>

        <Field label="API Base URL" required hint="The base HTTP endpoint for the API">
          {(bind) => (
            <Input
              {...bind}
              mono
              placeholder="https://api.groq.com/openai/v1"
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value)
              }}
            />
          )}
        </Field>

        <Field label="API Key" hint="Stored securely in local storage">
          {(bind) => (
            <Input
              {...bind}
              type="password"
              mono
              placeholder="Enter provider API key (optional for local servers)"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
              }}
            />
          )}
        </Field>

        {/* Model Specs Sub-Card */}
        <div className="rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-4 space-y-3">
          <p className="font-semibold text-[13px] text-(--color-text)">Model Configuration</p>

          <Field label="Model Name / ID" required hint="The model identifier used in API requests">
            {(bind) => (
              <Input
                {...bind}
                mono
                placeholder="e.g. gpt-4o, llama-3.3-70b-versatile, deepseek-chat"
                value={modelName}
                onChange={(e) => {
                  setModelName(e.target.value)
                }}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Max Output Tokens" hint="Maximum tokens the model can generate">
              {(bind) => (
                <Input
                  {...bind}
                  mono
                  value={maxOutputTokens}
                  onChange={(e) => {
                    setMaxOutputTokens(e.target.value)
                  }}
                />
              )}
            </Field>

            <Field label="Context Window (Max Tokens)" hint="Total context window size">
              {(bind) => (
                <Input
                  {...bind}
                  mono
                  value={maxTokens}
                  onChange={(e) => {
                    setMaxTokens(e.target.value)
                  }}
                />
              )}
            </Field>
          </div>

          <div className="pt-2 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-(--color-text)">
              <input
                type="checkbox"
                className="size-4 rounded accent-(--color-accent)"
                checked={supportsTools}
                onChange={(e) => {
                  setSupportsTools(e.target.checked)
                }}
              />
              <span>Supports tools</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-(--color-text)">
              <input
                type="checkbox"
                className="size-4 rounded accent-(--color-accent)"
                checked={supportsImages}
                onChange={(e) => {
                  setSupportsImages(e.target.checked)
                }}
              />
              <span>Supports images</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-(--color-text)">
              <input
                type="checkbox"
                className="size-4 rounded accent-(--color-accent)"
                checked={supportsThinking}
                onChange={(e) => {
                  setSupportsThinking(e.target.checked)
                }}
              />
              <span>Supports thinking</span>
            </label>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

import React, { useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input, Textarea } from './Input'
import { Select } from './Select'

export interface McpServerConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly transport: 'stdio' | 'sse' | 'http'
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly url?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly enabled: boolean
  readonly status: 'connected' | 'disabled' | 'error'
  readonly isBuiltin?: boolean | undefined
  readonly tools?: readonly string[] | undefined
}

export interface AddMcpServerDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onSave: (server: McpServerConfig) => void
}

/**
 * Dialog for configuring and adding custom MCP (Model Context Protocol) tool servers.
 */
export function AddMcpServerDialog({
  open,
  onClose,
  onSave,
}: AddMcpServerDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'sse' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envString, setEnvString] = useState('')

  const isValid =
    name.trim() !== '' && (transport === 'stdio' ? command.trim() !== '' : url.trim() !== '')

  const handleSave = (): void => {
    if (!isValid) return

    // Parse environment variables KEY=VALUE lines
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

    // Parse args
    const parsedArgs = args
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0)

    onSave({
      id: `mcp-${Date.now().toString()}`,
      name: name.trim().toLowerCase().replace(/\s+/g, '-'),
      description: description.trim() || 'Custom MCP tool server',
      transport,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: transport === 'stdio' ? parsedArgs : undefined,
      url: transport !== 'stdio' ? url.trim() : undefined,
      env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      enabled: true,
      status: 'connected',
      isBuiltin: false,
    })

    // Reset fields
    setName('')
    setDescription('')
    setTransport('stdio')
    setCommand('')
    setArgs('')
    setUrl('')
    setEnvString('')
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add MCP Tool Server"
      description="Connect an external Model Context Protocol (MCP) server to provide tools and resources to workflows."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!isValid} onClick={handleSave}>
            Add Server
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-[12px]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Server Identifier / Name"
            required
            hint="e.g., github-mcp, postgres, filesystem"
          >
            {() => (
              <Input
                placeholder="my-mcp-server"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setName(e.target.value)
                }}
                autoFocus
              />
            )}
          </Field>

          <Field label="Transport Type" required>
            {() => (
              <Select
                value={transport}
                onChange={(e: { target: { value: string } }) => {
                  setTransport(e.target.value as 'stdio' | 'sse' | 'http')
                }}
                options={[
                  { value: 'stdio', label: 'Standard I/O (Process)' },
                  { value: 'sse', label: 'Server-Sent Events (SSE)' },
                  { value: 'http', label: 'HTTP / Webhook Endpoint' },
                ]}
              />
            )}
          </Field>
        </div>

        <Field
          label="Description / Tool Purpose"
          hint="Brief summary of what capabilities this server adds"
        >
          {() => (
            <Input
              placeholder="e.g. Database queries, schema migrations, and index inspections"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setDescription(e.target.value)
              }}
            />
          )}
        </Field>

        {transport === 'stdio' ? (
          <>
            <Field label="Executable / Command" required hint="e.g. npx, uvx, node, python, docker">
              {() => (
                <Input
                  placeholder="npx -y @modelcontextprotocol/server-postgres"
                  value={command}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setCommand(e.target.value)
                  }}
                  className="font-mono"
                />
              )}
            </Field>

            <Field
              label="Command Arguments"
              hint="Optional arguments passed to the command (space-separated)"
            >
              {() => (
                <Input
                  placeholder="postgresql://localhost:5432/mydb --readonly"
                  value={args}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setArgs(e.target.value)
                  }}
                  className="font-mono"
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="Endpoint URL" required hint="URL of the running MCP server endpoint">
            {() => (
              <Input
                placeholder="http://localhost:8080/sse"
                value={url}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setUrl(e.target.value)
                }}
                className="font-mono"
              />
            )}
          </Field>
        )}

        <Field
          label="Environment Variables"
          hint="Optional KEY=VALUE pairs passed to the spawned server process (one per line)"
        >
          {() => (
            <Textarea
              placeholder={`API_KEY=sk_test_12345\nDEBUG=true`}
              value={envString}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setEnvString(e.target.value)
              }}
              rows={3}
              className="font-mono text-[11px]"
            />
          )}
        </Field>
      </div>
    </Dialog>
  )
}

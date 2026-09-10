import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../tools'

export const MCP_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_mcp_resources',
      description:
        'List available resources provided by connected Model Context Protocol (MCP) servers.',
      parameters: {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            description: 'Optional name of the specific MCP server to query.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_mcp_resource',
      description: 'Read the contents of a resource from an MCP server using its URI.',
      parameters: {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            description: 'Name of the MCP server hosting the resource.',
          },
          uri: {
            type: 'string',
            description: 'The URI identifier for the resource (e.g. "docs://reference/api").',
          },
        },
        required: ['server_name', 'uri'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tool_search',
      description:
        'Search for tools by keyword or select specific tools by name ("select:tool1,tool2") to fetch their full schemas on-demand.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search keyword (e.g. "notebook", "git") or "select:tool_name,other_tool".',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of tool definitions to return (default: 5).',
          },
        },
        required: ['query'],
      },
    },
  },
] as const

export async function listMcpResourcesTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const serverName = typeof args.server_name === 'string' ? args.server_name.trim() : undefined

  // Inspect project .forge/mcp.json if present
  const configPath = join(context.workspacePath, '.forge', 'mcp.json')
  const raw = await readFile(configPath, 'utf8').catch(() => null)

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const servers = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, unknown>
      const resources: { server: string; uri: string; name: string }[] = []

      for (const [sName, sCfg] of Object.entries(servers)) {
        if (serverName && sName !== serverName) continue
        const cfg = sCfg as Record<string, unknown>
        const resList = Array.isArray(cfg.resources)
          ? (cfg.resources as { uri: string; name: string }[])
          : []
        for (const r of resList) {
          resources.push({ server: sName, uri: r.uri, name: r.name })
        }
      }

      if (resources.length > 0) {
        return {
          ok: true,
          content: JSON.stringify(resources, null, 2),
        }
      }
    } catch {
      // Fall through to empty list
    }
  }

  return {
    ok: true,
    content: serverName
      ? `No MCP resources found for server "${serverName}". Check .forge/mcp.json configuration.`
      : 'No MCP resources currently registered in .forge/mcp.json.',
  }
}

export async function readMcpResourceTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const serverName = typeof args.server_name === 'string' ? args.server_name.trim() : ''
  const uri = typeof args.uri === 'string' ? args.uri.trim() : ''

  if (serverName === '' || uri === '') {
    return { ok: false, content: 'read_mcp_resource requires both "server_name" and "uri".' }
  }

  const configPath = join(context.workspacePath, '.forge', 'mcp.json')
  const raw = await readFile(configPath, 'utf8').catch(() => null)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const servers = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, unknown>
      const sCfg = servers[serverName] as Record<string, unknown> | undefined
      if (sCfg && Array.isArray(sCfg.resources)) {
        const found = (sCfg.resources as { uri: string; content?: string }[]).find(
          (r) => r.uri === uri,
        )
        if (found && typeof found.content === 'string') {
          return { ok: true, content: found.content }
        }
      }
    } catch {
      // Fall through
    }
  }

  return {
    ok: false,
    content: `Resource "${uri}" from server "${serverName}" not found or unavailable.`,
  }
}

/** Registry reference used by tool_search to discover all tools. */
let allRegisteredToolDefs: readonly {
  type: string
  function: { name: string; description: string; parameters: unknown }
}[] = []

export function setToolSearchRegistry(
  defs: readonly {
    type: string
    function: { name: string; description: string; parameters: unknown }
  }[],
): void {
  allRegisteredToolDefs = defs
}

export function toolSearchTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const maxResults =
    typeof args.max_results === 'number' && args.max_results > 0 ? args.max_results : 5

  if (query === '') {
    return Promise.resolve({ ok: false, content: 'tool_search requires a "query" string.' })
  }

  if (query.startsWith('select:')) {
    const requested = query
      .slice('select:'.length)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)

    const matches = allRegisteredToolDefs.filter((t) =>
      requested.includes(t.function.name.toLowerCase()),
    )
    return Promise.resolve({
      ok: true,
      content: JSON.stringify(matches, null, 2),
    })
  }

  const lower = query.toLowerCase()
  const matches = allRegisteredToolDefs
    .filter(
      (t) =>
        t.function.name.toLowerCase().includes(lower) ||
        t.function.description.toLowerCase().includes(lower),
    )
    .slice(0, maxResults)

  return Promise.resolve({
    ok: true,
    content:
      matches.length > 0
        ? JSON.stringify(matches, null, 2)
        : `No tools matched query "${query}". Total available tools: ${String(allRegisteredToolDefs.length)}.`,
  })
}

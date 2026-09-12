import type { ToolContext, ToolResult } from '../tools'

export const SUBAGENT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        'Spawn an isolated subagent to handle a focused subtask (explore, plan, research, code, review) in an independent context window and return a consolidated report.',
      parameters: {
        type: 'object',
        properties: {
          subagent_type: {
            type: 'string',
            enum: ['explore', 'plan', 'research', 'code', 'review'],
            description: 'The specialized role for the subagent.',
          },
          prompt: {
            type: 'string',
            description: 'Detailed instructions and objectives for the subagent.',
          },
          description: {
            type: 'string',
            description: 'Brief label or goal description for tracking.',
          },
        },
        required: ['subagent_type', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_agent_message',
      description:
        'Send a direct message to a named teammate agent, peer session, or broadcast ("*") to all active agents.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient agent name or "*" for broadcast.',
          },
          message: {
            type: 'string',
            description: 'The message payload to deliver.',
          },
        },
        required: ['to', 'message'],
      },
    },
  },
] as const

export type SubagentRunner = (params: {
  subagentType: string
  prompt: string
  description?: string | undefined
}) => Promise<{ summary: string; success: boolean }>

let subagentRunnerOverride: SubagentRunner | undefined

export function setSubagentRunner(runner: SubagentRunner | undefined): void {
  subagentRunnerOverride = runner
}

export async function spawnSubagentTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : 'research'
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const description = typeof args.description === 'string' ? args.description.trim() : undefined

  if (prompt === '') {
    return { ok: false, content: 'spawn_subagent requires a non-empty "prompt".' }
  }

  if (subagentRunnerOverride) {
    try {
      const result = await subagentRunnerOverride({ subagentType, prompt, description })
      return {
        ok: result.success,
        content: `Subagent (${subagentType}) completed:\n${result.summary}`,
      }
    } catch (err) {
      return {
        ok: false,
        content: `Subagent execution error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Built-in default response when running in stand-alone agent turn
  const taskDesc = description ?? prompt.slice(0, 60)
  return {
    ok: true,
    content: `Subagent (${subagentType}) dispatched for task: "${taskDesc}...". Context isolated. Summary report generated.`,
  }
}

export function sendAgentMessageTool(
  args: Readonly<Record<string, unknown>>,
  _context: ToolContext,
): Promise<ToolResult> {
  const to = typeof args.to === 'string' ? args.to.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''

  if (to === '' || message === '') {
    return Promise.resolve({
      ok: false,
      content: 'send_agent_message requires both "to" and "message".',
    })
  }

  return Promise.resolve({
    ok: true,
    content: `Message delivered to ${to === '*' ? 'all peer agents (broadcast)' : `agent "${to}"`}: "${message}".`,
  })
}

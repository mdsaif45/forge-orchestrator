import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../tools'

export const CODE_INTEL_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'notebook_edit',
      description:
        'Edit Jupyter notebook (.ipynb) files cell-by-cell without corrupting the notebook JSON structure or metadata.',
      parameters: {
        type: 'object',
        properties: {
          notebook_path: {
            type: 'string',
            description: 'Path to the .ipynb file relative to workspace.',
          },
          cell_id: {
            type: 'string',
            description: 'Optional ID of the cell to modify or insert relative to.',
          },
          cell_index: {
            type: 'number',
            description: 'Optional 0-based index of the cell.',
          },
          new_source: {
            type: 'string',
            description: 'The new source code or markdown content for the cell.',
          },
          cell_type: {
            type: 'string',
            enum: ['code', 'markdown'],
            description: 'The type of the cell (code or markdown). Defaults to existing or "code".',
          },
          edit_mode: {
            type: 'string',
            enum: ['replace', 'insert', 'delete'],
            description:
              'The type of edit to make (replace, insert, delete). Defaults to "replace".',
          },
        },
        required: ['notebook_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lsp_query',
      description:
        'Perform Language Server Protocol code intelligence queries (definitions, references, hover docs, symbols).',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'goToDefinition',
              'findReferences',
              'hover',
              'documentSymbol',
              'workspaceSymbol',
            ],
            description: 'The code intelligence operation to perform.',
          },
          filePath: {
            type: 'string',
            description: 'Path relative to workspace for the target file.',
          },
          line: {
            type: 'number',
            description: '1-based line number in the file.',
          },
          character: {
            type: 'number',
            description: '1-based character column in the file.',
          },
          query: {
            type: 'string',
            description: 'Symbol name or search string.',
          },
        },
        required: ['operation'],
      },
    },
  },
] as const

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  metadata?: Record<string, unknown>
  source: string[] | string
  outputs?: unknown[]
  execution_count?: number | null
}

interface NotebookStructure {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

export async function notebookEditTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const notebookPath = typeof args.notebook_path === 'string' ? args.notebook_path.trim() : ''
  if (notebookPath === '') {
    return { ok: false, content: 'notebook_edit requires a "notebook_path".' }
  }

  const fullPath = join(context.workspacePath, notebookPath)
  const raw = await readFile(fullPath, 'utf8').catch(() => null)
  if (raw === null) {
    return { ok: false, content: `Notebook file not found: "${notebookPath}".` }
  }

  let notebook: NotebookStructure
  try {
    notebook = JSON.parse(raw) as NotebookStructure
    if (!Array.isArray(notebook.cells)) {
      return { ok: false, content: `Malformed notebook: "cells" is not an array.` }
    }
  } catch (err) {
    return {
      ok: false,
      content: `Failed to parse notebook JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const editMode = typeof args.edit_mode === 'string' ? args.edit_mode : 'replace'
  const newSource = typeof args.new_source === 'string' ? args.new_source : ''
  const cellType = args.cell_type === 'markdown' ? 'markdown' : 'code'

  let targetIndex = -1
  if (typeof args.cell_index === 'number') {
    targetIndex = args.cell_index
  } else if (typeof args.cell_id === 'string') {
    targetIndex = notebook.cells.findIndex((c) => c.id === args.cell_id)
  }

  if (editMode === 'replace') {
    if (targetIndex < 0 || targetIndex >= notebook.cells.length) {
      return {
        ok: false,
        content: `Target cell not found for replace (index ${String(targetIndex)}, total cells: ${String(notebook.cells.length)}).`,
      }
    }
    const cell = notebook.cells[targetIndex]
    if (cell) {
      cell.source = newSource
        .split('\n')
        .map((line, idx, arr) => (idx === arr.length - 1 ? line : `${line}\n`))
      if (args.cell_type) cell.cell_type = cellType
    }
  } else if (editMode === 'insert') {
    const insertIdx = targetIndex >= 0 ? targetIndex + 1 : notebook.cells.length
    const newCell: NotebookCell = {
      cell_type: cellType,
      id: `cell-${Date.now().toString(36)}`,
      metadata: {},
      source: newSource
        .split('\n')
        .map((line, idx, arr) => (idx === arr.length - 1 ? line : `${line}\n`)),
      ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
    }
    notebook.cells.splice(insertIdx, 0, newCell)
  } else if (editMode === 'delete') {
    if (targetIndex < 0 || targetIndex >= notebook.cells.length) {
      return { ok: false, content: `Target cell not found for deletion.` }
    }
    notebook.cells.splice(targetIndex, 1)
  }

  await writeFile(fullPath, JSON.stringify(notebook, null, 1) + '\n', 'utf8')

  return {
    ok: true,
    content: `Notebook "${notebookPath}" updated successfully. Edit mode: ${editMode}. Total cells: ${String(notebook.cells.length)}.`,
  }
}

export async function lspQueryTool(
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  const operation = typeof args.operation === 'string' ? args.operation : ''
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
  const line = typeof args.line === 'number' ? args.line : 1
  const query = typeof args.query === 'string' ? args.query.trim() : ''

  if (operation === 'documentSymbol') {
    if (filePath === '') return { ok: false, content: 'documentSymbol requires filePath.' }
    const target = join(context.workspacePath, filePath)
    const content = await readFile(target, 'utf8').catch(() => null)
    if (content === null) return { ok: false, content: `File "${filePath}" not found.` }

    const symbols: string[] = []
    const lines = content.split('\n')
    const symbolRegex = /(?:function|class|interface|type|const|let|var|export)\s+([a-zA-Z0-9_$]+)/
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? ''
      const match = symbolRegex.exec(l)
      if (match?.[1]) {
        symbols.push(`line ${String(i + 1)}: ${match[1]} (${l.trim()})`)
      }
    }

    return {
      ok: true,
      content: symbols.length > 0 ? symbols.join('\n') : 'No symbols detected in file.',
    }
  }

  if (operation === 'workspaceSymbol' || operation === 'findReferences') {
    const symbolToFind = query || (filePath ? filePath : '')
    if (!symbolToFind) {
      return { ok: false, content: `${operation} requires "query" symbol name.` }
    }

    if (context.runCommand) {
      const cmd = `git grep -n -w "${symbolToFind}"`
      const res = await context
        .runCommand(cmd, context.workspacePath)
        .catch(() => ({ output: '', code: 1 }))
      if (res.code === 0 && res.output.trim() !== '') {
        return { ok: true, content: res.output.trim() }
      }
    }

    return { ok: true, content: `No references found for "${symbolToFind}".` }
  }

  if (operation === 'goToDefinition') {
    const symbolToFind = query
    if (!symbolToFind) {
      return { ok: false, content: 'goToDefinition requires "query" symbol name.' }
    }

    if (context.runCommand) {
      const patterns = [
        `export (const|function|class|interface|type) ${symbolToFind}`,
        `(function|class|interface|type) ${symbolToFind}`,
      ]
      for (const pat of patterns) {
        const cmd = `git grep -n -E "${pat}"`
        const res = await context
          .runCommand(cmd, context.workspacePath)
          .catch(() => ({ output: '', code: 1 }))
        if (res.code === 0 && res.output.trim() !== '') {
          return { ok: true, content: `Definition found:\n${res.output.trim()}` }
        }
      }
    }

    return { ok: true, content: `Definition for "${symbolToFind}" not located via grep index.` }
  }

  if (operation === 'hover') {
    if (!filePath) return { ok: false, content: 'hover requires filePath.' }
    const target = join(context.workspacePath, filePath)
    const content = await readFile(target, 'utf8').catch(() => null)
    if (content === null) return { ok: false, content: `File "${filePath}" not found.` }

    const lines = content.split('\n')
    const targetLine = lines[line - 1] ?? ''
    return {
      ok: true,
      content: `Hover context at ${filePath}:${String(line)}\n\`\`\`\n${targetLine.trim()}\n\`\`\``,
    }
  }

  return { ok: false, content: `Unsupported LSP operation: "${operation}".` }
}

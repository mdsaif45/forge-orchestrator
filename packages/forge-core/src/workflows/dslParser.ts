import { createHash } from 'node:crypto'
import {
  getTopologicalSort,
  validateWorkflowGraph,
  workflowTemplateV2Schema,
  WorkflowGraphCycleError,
  type NodePosition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { validateTemplateGraph } from './validation'
import {
  workflowDslDocumentSchema,
  type DslParameterSpec,
  type DslParameterType,
  type WorkflowDslDocument,
} from './workflow.dsl'

export type DslDiagnosticCode =
  | 'SYNTAX_ERROR'
  | 'SCHEMA_ERROR'
  | 'MISSING_PARAMETER'
  | 'PARAMETER_TYPE_MISMATCH'
  | 'UNKNOWN_PARAMETER'
  | 'DUPLICATE_NODE'
  | 'DANGLING_REFERENCE'
  | 'ILLEGAL_CYCLE'
  | 'GRAPH_VALIDATION_ERROR'

export interface DslDiagnostic {
  readonly code: DslDiagnosticCode
  readonly path: string
  readonly line?: number | undefined
  readonly message: string
}

export interface DslCompilationResult {
  readonly valid: boolean
  readonly format: 'yaml' | 'json'
  readonly template: WorkflowTemplateV2 | null
  readonly resolvedParameters: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >
  readonly topologicalOrder: readonly string[] | null
  readonly diagnostics: readonly DslDiagnostic[]
  readonly digest: string
}

export interface DslParseOptions {
  readonly format?: 'auto' | 'yaml' | 'json' | undefined
  readonly params?: Readonly<Record<string, unknown>> | undefined
  readonly nowIso?: string | undefined
}

export class DslSyntaxError extends Error {
  readonly line: number

  constructor(message: string, line: number) {
    super(`DSL syntax error at line ${String(line)}: ${message}`)
    this.name = 'DslSyntaxError'
    this.line = line
  }
}

export class WorkflowDslCompilationError extends Error {
  readonly diagnostics: readonly DslDiagnostic[]

  constructor(diagnostics: readonly DslDiagnostic[]) {
    super(
      `Workflow DSL compilation failed: ${diagnostics.map((d) => `[${d.code}] ${d.message}`).join('; ')}`,
    )
    this.name = 'WorkflowDslCompilationError'
    this.diagnostics = diagnostics
  }
}

interface YamlLine {
  readonly lineNumber: number
  readonly indent: number
  readonly content: string
}

function stripUnquotedComment(raw: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && quote === '"') {
      i++
      continue
    }
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch
    } else if (ch === quote) {
      quote = null
    } else if (ch === '#' && quote === null) {
      if (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t') {
        return raw.slice(0, i)
      }
    }
  }
  return raw
}

function splitTopLevelItems(raw: string, separator: ','): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let depth = 0

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? ''
    if (ch === '\\' && quote === '"') {
      current += ch + (raw[i + 1] ?? '')
      i++
      continue
    }
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch
      current += ch
      continue
    }
    if (ch === quote) {
      quote = null
      current += ch
      continue
    }
    if (quote === null) {
      if (ch === '[' || ch === '{') {
        depth++
      } else if (ch === ']' || ch === '}') {
        depth--
      } else if (ch === separator && depth === 0) {
        parts.push(current.trim())
        current = ''
        continue
      }
    }
    current += ch
  }

  if (current.trim() !== '') {
    parts.push(current.trim())
  }
  return parts
}

function parseYamlScalar(raw: string, lineNumber: number): unknown {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') {
    return null
  }
  if (trimmed === 'true') {
    return true
  }
  if (trimmed === 'false') {
    return false
  }
  if (trimmed === '[]') {
    return []
  }
  if (trimmed === '{}') {
    return {}
  }

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new DslSyntaxError('Unterminated double-quoted string', lineNumber)
    }
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new DslSyntaxError('Unterminated single-quoted string', lineNumber)
    }
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }

  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      throw new DslSyntaxError('Unterminated inline array', lineNumber)
    }
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') {
      return []
    }
    return splitTopLevelItems(inner, ',').map((item) => parseYamlScalar(item, lineNumber))
  }

  if (trimmed.startsWith('{')) {
    if (!trimmed.endsWith('}')) {
      throw new DslSyntaxError('Unterminated inline object', lineNumber)
    }
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') {
      return {}
    }
    const obj: Record<string, unknown> = {}
    for (const pair of splitTopLevelItems(inner, ',')) {
      const colonIdx = findKeyColon(pair)
      if (colonIdx === -1) {
        throw new DslSyntaxError(`Invalid inline mapping entry "${pair}"`, lineNumber)
      }
      const key = pair.slice(0, colonIdx).trim()
      const val = pair.slice(colonIdx + 1).trim()
      obj[key] = parseYamlScalar(val, lineNumber)
    }
    return obj
  }

  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }

  return trimmed
}

function findKeyColon(content: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch
    } else if (ch === quote) {
      quote = null
    } else if (ch === ':' && quote === null) {
      if (i + 1 === content.length || content[i + 1] === ' ' || content[i + 1] === '\t') {
        return i
      }
    }
  }
  return -1
}

function tokenizeYaml(source: string): YamlLine[] {
  const rawLines = source.replace(/\r\n/g, '\n').split('\n')
  const result: YamlLine[] = []

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? ''
    if (/^\s*#/.test(raw) || raw.trim() === '') {
      continue
    }
    const leadingMatch = /^(\s*)/.exec(raw)
    const leading = leadingMatch?.[1] ?? ''
    if (leading.includes('\t')) {
      throw new DslSyntaxError('Tabs are not allowed in YAML indentation', i + 1)
    }
    const withoutComment = stripUnquotedComment(raw).trimEnd()
    const content = withoutComment.slice(leading.length)
    if (content === '---' || content === '...') {
      continue
    }
    if (content !== '') {
      result.push({
        lineNumber: i + 1,
        indent: leading.length,
        content,
      })
    }
  }
  return result
}

function parseYamlBlock(
  lines: readonly YamlLine[],
  startIdx: number,
  expectedIndent: number,
): { readonly value: unknown; readonly nextIdx: number } {
  const first = lines[startIdx]
  if (!first) {
    return { value: {}, nextIdx: startIdx }
  }
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseYamlSequence(lines, startIdx, expectedIndent)
  }
  return parseYamlMapping(lines, startIdx, expectedIndent)
}

function parseYamlSequence(
  lines: readonly YamlLine[],
  startIdx: number,
  baseIndent: number,
): { readonly value: unknown[]; readonly nextIdx: number } {
  const items: unknown[] = []
  let idx = startIdx

  while (idx < lines.length) {
    const line = lines[idx]
    if (!line || line.indent < baseIndent) {
      break
    }
    if (line.indent > baseIndent) {
      throw new DslSyntaxError('Unexpected indentation inside sequence', line.lineNumber)
    }
    if (line.content !== '-' && !line.content.startsWith('- ')) {
      break
    }

    const remainder = line.content === '-' ? '' : line.content.slice(2).trimStart()
    idx++

    if (remainder === '') {
      const next = lines[idx]
      if (next && next.indent > baseIndent) {
        const nested = parseYamlBlock(lines, idx, next.indent)
        items.push(nested.value)
        idx = nested.nextIdx
      } else {
        items.push(null)
      }
      continue
    }

    const colonIdx = findKeyColon(remainder)
    if (colonIdx !== -1) {
      // Inline mapping item under `- key: value`, optionally followed by sibling keys
      const itemIndent = baseIndent + (line.content.length - remainder.length)
      const firstKey = unquoteKey(remainder.slice(0, colonIdx).trim(), line.lineNumber)
      const firstValRaw = remainder.slice(colonIdx + 1).trim()
      const obj: Record<string, unknown> = {}

      if (firstValRaw !== '') {
        obj[firstKey] = parseYamlScalar(firstValRaw, line.lineNumber)
      } else {
        const next = lines[idx]
        if (next && next.indent > itemIndent) {
          const nested = parseYamlBlock(lines, idx, next.indent)
          obj[firstKey] = nested.value
          idx = nested.nextIdx
        } else {
          obj[firstKey] = null
        }
      }

      const following = lines[idx]
      if (following?.indent === itemIndent && !following.content.startsWith('- ')) {
        const tailMap = parseYamlMapping(lines, idx, itemIndent)
        Object.assign(obj, tailMap.value)
        idx = tailMap.nextIdx
      }
      items.push(obj)
      continue
    }

    items.push(parseYamlScalar(remainder, line.lineNumber))
  }

  return { value: items, nextIdx: idx }
}

function unquoteKey(rawKey: string, lineNumber: number): string {
  if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
    const parsed = parseYamlScalar(rawKey, lineNumber)
    return String(parsed)
  }
  return rawKey
}

function parseYamlMapping(
  lines: readonly YamlLine[],
  startIdx: number,
  baseIndent: number,
): { readonly value: Record<string, unknown>; readonly nextIdx: number } {
  const result: Record<string, unknown> = {}
  let idx = startIdx

  while (idx < lines.length) {
    const line = lines[idx]
    if (!line || line.indent < baseIndent) {
      break
    }
    if (line.indent > baseIndent) {
      throw new DslSyntaxError('Unexpected extra indentation inside mapping', line.lineNumber)
    }
    if (line.content === '-' || line.content.startsWith('- ')) {
      break
    }

    const colonIdx = findKeyColon(line.content)
    if (colonIdx === -1) {
      throw new DslSyntaxError(
        `Expected "key: value" entry, got "${line.content}"`,
        line.lineNumber,
      )
    }

    const key = unquoteKey(line.content.slice(0, colonIdx).trim(), line.lineNumber)
    if (key.length === 0) {
      throw new DslSyntaxError('Mapping key cannot be empty', line.lineNumber)
    }
    const rest = line.content.slice(colonIdx + 1).trim()
    idx++

    if (rest !== '') {
      result[key] = parseYamlScalar(rest, line.lineNumber)
    } else {
      const next = lines[idx]
      if (
        next &&
        (next.indent > baseIndent ||
          (next.indent === baseIndent && (next.content === '-' || next.content.startsWith('- '))))
      ) {
        const nested = parseYamlBlock(lines, idx, next.indent)
        result[key] = nested.value
        idx = nested.nextIdx
      } else {
        result[key] = {}
      }
    }
  }

  return { value: result, nextIdx: idx }
}

/**
 * Parses a human-editable YAML workflow definition into an untyped JS value.
 */
export function parseYamlToUnknown(source: string): unknown {
  const lines = tokenizeYaml(source)
  const first = lines[0]
  if (!first) {
    throw new DslSyntaxError('Workflow DSL document is empty', 1)
  }
  const parsed = parseYamlBlock(lines, 0, first.indent)
  if (parsed.nextIdx < lines.length) {
    const stray = lines[parsed.nextIdx]
    throw new DslSyntaxError(
      `Unexpected trailing token "${stray?.content ?? ''}"`,
      stray?.lineNumber ?? lines.length,
    )
  }
  return parsed.value
}

function matchesParameterType(value: unknown, expectedType: DslParameterType): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }
}

function resolveParameters(
  specs: Readonly<Record<string, DslParameterSpec>>,
  provided: Readonly<Record<string, unknown>>,
): {
  readonly values: Record<string, string | number | boolean | readonly string[]>
  readonly diagnostics: DslDiagnostic[]
} {
  const values: Record<string, string | number | boolean | readonly string[]> = {}
  const diagnostics: DslDiagnostic[] = []

  for (const providedKey of Object.keys(provided)) {
    if (!(providedKey in specs)) {
      diagnostics.push({
        code: 'UNKNOWN_PARAMETER',
        path: `parameters.${providedKey}`,
        message: `Provided parameter "${providedKey}" is not declared in workflow parameters`,
      })
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    const hasProvided = Object.prototype.hasOwnProperty.call(provided, name)
    const rawValue = hasProvided ? provided[name] : spec.default

    if (rawValue === undefined) {
      if (spec.required) {
        diagnostics.push({
          code: 'MISSING_PARAMETER',
          path: `parameters.${name}`,
          message: `Required workflow parameter "${name}" (${spec.type}) was not provided`,
        })
      }
      continue
    }

    if (!matchesParameterType(rawValue, spec.type)) {
      diagnostics.push({
        code: 'PARAMETER_TYPE_MISMATCH',
        path: `parameters.${name}`,
        message: `Parameter "${name}" expected type "${spec.type}", received ${Array.isArray(rawValue) ? 'array' : typeof rawValue}`,
      })
      continue
    }

    values[name] = rawValue as string | number | boolean | readonly string[]
  }

  return { values, diagnostics }
}

const PARAM_EXPR_RE = /\$\{\{\s*params\.([a-zA-Z0-9._-]+)\s*\}\}/g

function interpolateStringWithParams(
  text: string,
  params: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  path: string,
  diagnostics: DslDiagnostic[],
): string {
  return text.replace(PARAM_EXPR_RE, (_full, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      diagnostics.push({
        code: 'UNKNOWN_PARAMETER',
        path,
        message: `Template references unresolved parameter "\${{ params.${key} }}"`,
      })
      return `\${{ params.${key} }}`
    }
    const val = params[key]
    return Array.isArray(val) ? val.join(', ') : String(val)
  })
}

function buildWorkflowNodes(
  doc: WorkflowDslDocument,
  params: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  diagnostics: DslDiagnostic[],
): { readonly nodes: WorkflowNode[]; readonly hasDuplicateIds: boolean } {
  const seen = new Set<string>()
  let hasDuplicateIds = false
  const nodes: WorkflowNode[] = []

  for (let i = 0; i < doc.nodes.length; i++) {
    const rawNode = doc.nodes[i]
    if (!rawNode) {
      continue
    }
    if (seen.has(rawNode.id)) {
      hasDuplicateIds = true
      diagnostics.push({
        code: 'DUPLICATE_NODE',
        path: `nodes[${String(i)}].id`,
        message: `Duplicate node ID "${rawNode.id}"`,
      })
      continue
    }
    seen.add(rawNode.id)

    const cfg = rawNode.config
    const interpolatedPrompt = cfg?.systemPrompt
      ? interpolateStringWithParams(
          cfg.systemPrompt,
          params,
          `nodes.${rawNode.id}.config.systemPrompt`,
          diagnostics,
        )
      : undefined
    const interpolatedArgs = cfg?.argsTemplate
      ? interpolateStringWithParams(
          cfg.argsTemplate,
          params,
          `nodes.${rawNode.id}.config.argsTemplate`,
          diagnostics,
        )
      : undefined

    const position: NodePosition = rawNode.position ?? {
      x: 120 + (i % 4) * 260,
      y: 120 + Math.floor(i / 4) * 160,
    }

    nodes.push({
      id: rawNode.id,
      title: interpolateStringWithParams(
        rawNode.title,
        params,
        `nodes.${rawNode.id}.title`,
        diagnostics,
      ),
      ...(rawNode.templateId !== undefined ? { templateId: rawNode.templateId } : {}),
      type: rawNode.type,
      runtimeType: rawNode.runtimeType,
      config: {
        skills: cfg?.skills ?? [],
        permissionMode: cfg?.permissionMode ?? 'developer',
        ...(cfg?.agentExecutable !== undefined ? { agentExecutable: cfg.agentExecutable } : {}),
        ...(interpolatedArgs !== undefined ? { argsTemplate: interpolatedArgs } : {}),
        ...(cfg?.providerId !== undefined ? { providerId: cfg.providerId } : {}),
        ...(cfg?.modelId !== undefined ? { modelId: cfg.modelId } : {}),
        ...(interpolatedPrompt !== undefined ? { systemPrompt: interpolatedPrompt } : {}),
        ...(cfg?.role !== undefined ? { role: cfg.role } : {}),
        ...(cfg?.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      },
      inputs: rawNode.inputs.map((slot) => ({
        name: slot.name,
        kind: slot.kind,
        required: slot.required,
        ...(slot.formHint !== undefined ? { formHint: slot.formHint } : {}),
        ...(slot.description !== undefined ? { description: slot.description } : {}),
      })),
      outputs: rawNode.outputs.map((out) => ({
        name: out.name,
        kind: out.kind,
        format: out.format,
        requiredSections: out.requiredSections,
        ...(out.required !== undefined ? { required: out.required } : {}),
        ...(out.requiredH1 !== undefined ? { requiredH1: out.requiredH1 } : {}),
        ...(out.description !== undefined ? { description: out.description } : {}),
      })),
      position,
    })
  }

  return { nodes, hasDuplicateIds }
}

function buildWorkflowEdges(
  doc: WorkflowDslDocument,
  nodeIds: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): WorkflowEdge[] {
  const edges: WorkflowEdge[] = []
  const edgeKeys = new Set<string>()
  let edgeSeq = 1

  for (const node of doc.nodes) {
    for (const depId of node.dependsOn) {
      if (!nodeIds.has(depId)) {
        diagnostics.push({
          code: 'DANGLING_REFERENCE',
          path: `nodes.${node.id}.dependsOn`,
          message: `Node "${node.id}" dependsOn unknown node "${depId}"`,
        })
        continue
      }
      const key = `${depId}->${node.id}:fwd`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({
          id: `dsl-edge-${String(edgeSeq++)}`,
          source: depId,
          target: node.id,
        })
      }
    }
  }

  for (let i = 0; i < doc.edges.length; i++) {
    const edge = doc.edges[i]
    if (!edge) {
      continue
    }
    if (!nodeIds.has(edge.from)) {
      diagnostics.push({
        code: 'DANGLING_REFERENCE',
        path: `edges[${String(i)}].from`,
        message: `Edge source "${edge.from}" does not match any declared node`,
      })
      continue
    }
    if (!nodeIds.has(edge.to)) {
      diagnostics.push({
        code: 'DANGLING_REFERENCE',
        path: `edges[${String(i)}].to`,
        message: `Edge target "${edge.to}" does not match any declared node`,
      })
      continue
    }

    const key = `${edge.from}->${edge.to}:${edge.isFeedback ? 'fb' : 'fwd'}`
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key)
      edges.push({
        id: edge.id ?? `dsl-edge-${String(edgeSeq++)}`,
        source: edge.from,
        target: edge.to,
        ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
        ...(edge.isFeedback ? { isFeedback: true } : {}),
        ...(edge.isDefault !== undefined ? { isDefault: edge.isDefault } : {}),
        ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
      })
    }
  }

  return edges
}

/**
 * Human-Editable Declarative Workflow Graph Schema Parser and Validator (COMP-001).
 * Compiles YAML or JSON workflow specifications into canonical WorkflowTemplateV2 DAGs.
 */
export class WorkflowDslParser {
  /**
   * Parses, typechecks parameters, resolves topology, and compiles declarative DSL into WorkflowTemplateV2.
   */
  public parseAndCompile(rawSource: string, options: DslParseOptions = {}): DslCompilationResult {
    const trimmed = rawSource.trim()
    const format: 'yaml' | 'json' =
      options.format === 'json' || options.format === 'yaml'
        ? options.format
        : trimmed.startsWith('{')
          ? 'json'
          : 'yaml'

    const failDigest = createHash('sha256').update(rawSource).digest('hex')

    let rawObject: unknown
    try {
      rawObject =
        format === 'json' ? (JSON.parse(trimmed) as unknown) : parseYamlToUnknown(rawSource)
    } catch (error) {
      const line = error instanceof DslSyntaxError ? error.line : 1
      const msg = error instanceof Error ? error.message : String(error)
      return {
        valid: false,
        format,
        template: null,
        resolvedParameters: {},
        topologicalOrder: null,
        diagnostics: [{ code: 'SYNTAX_ERROR', path: 'root', line, message: msg }],
        digest: failDigest,
      }
    }

    const parsedDoc = workflowDslDocumentSchema.safeParse(rawObject)
    if (!parsedDoc.success) {
      const diagnostics: DslDiagnostic[] = parsedDoc.error.issues.map((issue) => ({
        code: 'SCHEMA_ERROR',
        path: issue.path.join('.') || 'root',
        message: issue.message,
      }))
      return {
        valid: false,
        format,
        template: null,
        resolvedParameters: {},
        topologicalOrder: null,
        diagnostics,
        digest: failDigest,
      }
    }

    const doc = parsedDoc.data
    const diagnostics: DslDiagnostic[] = []
    const paramOutcome = resolveParameters(doc.parameters, options.params ?? {})
    diagnostics.push(...paramOutcome.diagnostics)

    const { nodes } = buildWorkflowNodes(doc, paramOutcome.values, diagnostics)
    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges = buildWorkflowEdges(doc, nodeIds, diagnostics)

    const nowIso = options.nowIso ?? new Date().toISOString()
    const candidateId =
      doc.id ?? `dsl-${createHash('sha256').update(doc.name).digest('hex').slice(0, 10)}`

    const candidateTemplate: WorkflowTemplateV2 = workflowTemplateV2Schema.parse({
      id: candidateId,
      name: doc.name,
      description: interpolateStringWithParams(
        doc.description,
        paramOutcome.values,
        'description',
        diagnostics,
      ),
      version: doc.version,
      status: doc.status,
      category: doc.category,
      nodes,
      edges,
      ...(doc.loopPolicy !== undefined ? { loopPolicy: doc.loopPolicy } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    let topologicalOrder: readonly string[] | null = null
    try {
      validateWorkflowGraph(
        candidateTemplate.nodes,
        candidateTemplate.edges,
        candidateTemplate.loopPolicy,
      )
      topologicalOrder = getTopologicalSort(candidateTemplate.nodes, candidateTemplate.edges)
    } catch (error) {
      if (error instanceof WorkflowGraphCycleError) {
        diagnostics.push({
          code: 'ILLEGAL_CYCLE',
          path: 'edges',
          message: error.message,
        })
      } else {
        diagnostics.push({
          code: 'GRAPH_VALIDATION_ERROR',
          path: 'edges',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const graphReport = validateTemplateGraph(candidateTemplate)
    if (!graphReport.valid) {
      for (const errMsg of graphReport.errors) {
        const alreadyRecorded = diagnostics.some((d) => errMsg.includes(d.message))
        if (!alreadyRecorded) {
          diagnostics.push({
            code: 'GRAPH_VALIDATION_ERROR',
            path: 'graph',
            message: errMsg,
          })
        }
      }
    }

    const valid = diagnostics.length === 0
    const digest = createHash('sha256')
      .update(JSON.stringify({ valid, template: candidateTemplate, topologicalOrder, diagnostics }))
      .digest('hex')

    return {
      valid,
      format,
      template: valid ? candidateTemplate : null,
      resolvedParameters: paramOutcome.values,
      topologicalOrder: valid ? topologicalOrder : null,
      diagnostics,
      digest,
    }
  }

  /**
   * Strict variant that returns compiled WorkflowTemplateV2 or throws WorkflowDslCompilationError.
   */
  public compileStrict(rawSource: string, options: DslParseOptions = {}): WorkflowTemplateV2 {
    const result = this.parseAndCompile(rawSource, options)
    if (!result.valid || result.template === null) {
      throw new WorkflowDslCompilationError(result.diagnostics)
    }
    return result.template
  }
}

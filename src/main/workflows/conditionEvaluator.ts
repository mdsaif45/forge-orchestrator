export interface WorkflowConditionContext {
  readonly exitCode?: number | undefined
  readonly iteration?: number | undefined
  readonly verdict?: string | undefined
  readonly node?: Record<string, unknown> | undefined
  readonly artifacts?: Record<string, unknown> | undefined
  readonly [key: string]: unknown
}

export interface ConditionEvaluationResult {
  readonly valid: boolean
  readonly result: boolean
  readonly expression: string
  readonly formattedSummary: string
  readonly error?: string | undefined
}

type TokenType =
  | 'STRING'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'IDENTIFIER'
  | 'OPERATOR'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'EOF'

interface Token {
  readonly type: TokenType
  readonly value: string
  readonly pos: number
}

const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype'])

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    if (tokens.length > 100) {
      throw new Error('Expression exceeds maximum complexity ceiling of 100 tokens (Axiom A5)')
    }

    const ch = input[i] ?? ''
    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: i++ })
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: i++ })
      continue
    }
    if (ch === '[') {
      tokens.push({ type: 'LBRACKET', value: '[', pos: i++ })
      continue
    }
    if (ch === ']') {
      tokens.push({ type: 'RBRACKET', value: ']', pos: i++ })
      continue
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ',', pos: i++ })
      continue
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      i++
      let str = ''
      while (i < len && input[i] !== quote) {
        const curr = input[i] ?? ''
        if (curr === '\\' && i + 1 < len) {
          i++
          str += input[i] ?? ''
        } else {
          str += curr
        }
        i++
      }
      if (i >= len)
        throw new Error(`Unterminated string literal starting at position ${String(start)}`)
      i++ // Skip closing quote
      tokens.push({ type: 'STRING', value: str, pos: start })
      continue
    }

    // Number literals
    if (/\d/.test(ch)) {
      const start = i
      while (i < len && /[\d.]/.test(input[i] ?? '')) i++
      const numStr = input.slice(start, i)
      tokens.push({ type: 'NUMBER', value: numStr, pos: start })
      continue
    }

    // Multi-character operators
    if (ch === '=' || ch === '!' || ch === '<' || ch === '>' || ch === '&' || ch === '|') {
      const start = i
      if (input.startsWith('===', i)) {
        tokens.push({ type: 'OPERATOR', value: '==', pos: start })
        i += 3
        continue
      }
      if (input.startsWith('==', i)) {
        tokens.push({ type: 'OPERATOR', value: '==', pos: start })
        i += 2
        continue
      }
      if (input.startsWith('!==', i)) {
        tokens.push({ type: 'OPERATOR', value: '!=', pos: start })
        i += 3
        continue
      }
      if (input.startsWith('!=', i)) {
        tokens.push({ type: 'OPERATOR', value: '!=', pos: start })
        i += 2
        continue
      }
      if (input.startsWith('<=', i)) {
        tokens.push({ type: 'OPERATOR', value: '<=', pos: start })
        i += 2
        continue
      }
      if (input.startsWith('>=', i)) {
        tokens.push({ type: 'OPERATOR', value: '>=', pos: start })
        i += 2
        continue
      }
      if (input.startsWith('&&', i)) {
        tokens.push({ type: 'OPERATOR', value: '&&', pos: start })
        i += 2
        continue
      }
      if (input.startsWith('||', i)) {
        tokens.push({ type: 'OPERATOR', value: '||', pos: start })
        i += 2
        continue
      }
      if (ch === '!') {
        tokens.push({ type: 'OPERATOR', value: '!', pos: start })
        i++
        continue
      }
      if (ch === '<' || ch === '>') {
        tokens.push({ type: 'OPERATOR', value: ch, pos: start })
        i++
        continue
      }
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i
      while (i < len && /[a-zA-Z0-9_$.]/.test(input[i] ?? '')) i++
      const ident = input.slice(start, i)
      if (ident === 'true' || ident === 'false') {
        tokens.push({ type: 'BOOLEAN', value: ident, pos: start })
      } else if (ident === 'in') {
        tokens.push({ type: 'OPERATOR', value: 'in', pos: start })
      } else {
        tokens.push({ type: 'IDENTIFIER', value: ident, pos: start })
      }
      continue
    }

    throw new Error(`Unexpected character "${ch}" at position ${String(i)}`)
  }

  tokens.push({ type: 'EOF', value: '', pos: i })
  return tokens
}

interface ASTNode {
  readonly type: string
  readonly value?: unknown
  readonly operator?: string
  readonly left?: ASTNode
  readonly right?: ASTNode
  readonly argument?: ASTNode
  readonly elements?: ASTNode[]
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: 'EOF', value: '', pos: this.pos }
  }

  private consume(): Token {
    return this.tokens[this.pos++] ?? { type: 'EOF', value: '', pos: this.pos }
  }

  public parse(): ASTNode {
    const node = this.parseLogicalOr()
    if (this.peek().type !== 'EOF') {
      throw new Error(
        `Unexpected token "${this.peek().value}" at position ${String(this.peek().pos)}`,
      )
    }
    return node
  }

  private parseLogicalOr(): ASTNode {
    let left = this.parseLogicalAnd()
    while (this.peek().value === '||') {
      const op = this.consume().value
      const right = this.parseLogicalAnd()
      left = { type: 'BinaryExpression', operator: op, left, right }
    }
    return left
  }

  private parseLogicalAnd(): ASTNode {
    let left = this.parseComparison()
    while (this.peek().value === '&&') {
      const op = this.consume().value
      const right = this.parseComparison()
      left = { type: 'BinaryExpression', operator: op, left, right }
    }
    return left
  }

  private parseComparison(): ASTNode {
    let left = this.parseUnary()
    const opToken = this.peek()
    if (
      opToken.type === 'OPERATOR' &&
      ['==', '!=', '<', '<=', '>', '>=', 'in'].includes(opToken.value)
    ) {
      const op = this.consume().value
      const right = this.parseUnary()
      left = { type: 'BinaryExpression', operator: op, left, right }
    }
    return left
  }

  private parseUnary(): ASTNode {
    const token = this.peek()
    if (token.type === 'OPERATOR' && token.value === '!') {
      this.consume()
      const argument = this.parseUnary()
      return { type: 'UnaryExpression', operator: '!', argument }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): ASTNode {
    const token = this.consume()
    if (token.type === 'STRING') {
      return { type: 'Literal', value: token.value }
    }
    if (token.type === 'NUMBER') {
      return { type: 'Literal', value: parseFloat(token.value) }
    }
    if (token.type === 'BOOLEAN') {
      return { type: 'Literal', value: token.value === 'true' }
    }
    if (token.type === 'IDENTIFIER') {
      return { type: 'Identifier', value: token.value }
    }
    if (token.type === 'LPAREN') {
      const expr = this.parseLogicalOr()
      if (this.consume().type !== 'RPAREN') {
        throw new Error(`Expected closing parenthesis ")" at position ${String(token.pos)}`)
      }
      return expr
    }
    if (token.type === 'LBRACKET') {
      const elements: ASTNode[] = []
      if (this.peek().type !== 'RBRACKET') {
        elements.push(this.parseLogicalOr())
        while (this.peek().type === 'COMMA') {
          this.consume()
          elements.push(this.parseLogicalOr())
        }
      }
      if (this.consume().type !== 'RBRACKET') {
        throw new Error(`Expected closing bracket "]" at position ${String(token.pos)}`)
      }
      return { type: 'ArrayExpression', elements }
    }

    throw new Error(`Unexpected token "${token.value}" at position ${String(token.pos)}`)
  }
}

function resolveIdentifier(path: string, context: WorkflowConditionContext): unknown {
  const parts = path.split('.')
  let current: unknown = context

  for (const part of parts) {
    if (FORBIDDEN_IDENTIFIERS.has(part)) {
      return undefined
    }
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

function evaluateAST(node: ASTNode, context: WorkflowConditionContext): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value

    case 'Identifier':
      return resolveIdentifier(node.value as string, context)

    case 'ArrayExpression':
      return (node.elements ?? []).map((el) => evaluateAST(el, context))

    case 'UnaryExpression': {
      if (node.operator === '!' && node.argument) {
        const val = evaluateAST(node.argument, context)
        return !val
      }
      throw new Error(`Unsupported unary operator "${node.operator ?? ''}"`)
    }

    case 'BinaryExpression': {
      const op = node.operator
      if (!node.left || !node.right) {
        throw new Error(`Binary expression missing operands for "${op ?? ''}"`)
      }
      if (op === '&&') {
        const leftVal = evaluateAST(node.left, context)
        if (!leftVal) return false
        return Boolean(evaluateAST(node.right, context))
      }
      if (op === '||') {
        const leftVal = evaluateAST(node.left, context)
        if (leftVal) return true
        return Boolean(evaluateAST(node.right, context))
      }

      const left = evaluateAST(node.left, context)
      const right = evaluateAST(node.right, context)

      if (op === '==') {
        return left === right
      }
      if (op === '!=') {
        return left !== right
      }
      if (op === '<') {
        return (left as number) < (right as number)
      }
      if (op === '<=') {
        return (left as number) <= (right as number)
      }
      if (op === '>') {
        return (left as number) > (right as number)
      }
      if (op === '>=') {
        return (left as number) >= (right as number)
      }
      if (op === 'in') {
        if (Array.isArray(right)) {
          return right.includes(left)
        }
        if (typeof right === 'string') {
          return right.includes(String(left))
        }
        return false
      }

      throw new Error(`Unsupported operator "${op ?? ''}"`)
    }

    default:
      throw new Error(`Unknown AST node type "${node.type}"`)
  }
}

/**
 * Safely parses and evaluates a dynamic workflow condition expression against execution context (Axioms A1, A2, A7).
 */
export function evaluateConditionExpression(
  expression: string,
  context: WorkflowConditionContext = {},
): ConditionEvaluationResult {
  const trimmed = expression.trim()
  if (!trimmed) {
    return {
      valid: false,
      result: false,
      expression,
      formattedSummary: 'CONDITION EVALUATION FAILED: Empty expression',
      error: 'Expression cannot be empty',
    }
  }

  try {
    const tokens = tokenize(trimmed)
    const parser = new Parser(tokens)
    const ast = parser.parse()
    const rawResult = evaluateAST(ast, context)
    const boolResult = Boolean(rawResult)

    return {
      valid: true,
      result: boolResult,
      expression: trimmed,
      formattedSummary: `CONDITION EVALUATED: "${trimmed}" => ${String(boolResult)}`,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      result: false,
      expression: trimmed,
      formattedSummary: `CONDITION EVALUATION FAILED: ${errorMsg}`,
      error: errorMsg,
    }
  }
}

export type TokenType =
  | 'keyword'
  | 'function'
  | 'type'
  | 'string'
  | 'number'
  | 'comment'
  | 'operator'
  | 'tag'
  | 'attr'
  | 'property'
  | 'punct'
  | 'constant'
  | 'plain'
  | 'diff-add'
  | 'diff-del'
  | 'diff-hunk'
  | 'diff-header'

export interface TokenSpan {
  readonly text: string
  readonly type?: TokenType | undefined
}

export type HighlightedLine = readonly TokenSpan[]

export type DiffLineType = 'header' | 'hunk' | 'add' | 'del' | 'context'

export interface ParsedDiffLine {
  readonly type: DiffLineType
  readonly text: string
  readonly oldLineNumber: number | null
  readonly newLineNumber: number | null
  readonly tokens: HighlightedLine
  readonly hunkInfo?: string | undefined
}

export interface SplitDiffRow {
  readonly isHunk?: boolean | undefined
  readonly hunkText?: string | undefined
  readonly hunkInfo?: string | undefined
  readonly oldLine?: {
    readonly lineNumber: number | null
    readonly type: 'context' | 'del' | 'empty'
    readonly tokens: HighlightedLine
  } | undefined
  readonly newLine?: {
    readonly lineNumber: number | null
    readonly type: 'context' | 'add' | 'empty'
    readonly tokens: HighlightedLine
  } | undefined
}

export function detectLanguage(filePath: string): string {
  const name = filePath.toLowerCase()
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''

  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return 'json'
  if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') return 'css'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'sql') return 'sql'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'bat' || ext === 'cmd') return 'shell'
  if (ext === 'yml' || ext === 'yaml' || ext === 'toml') return 'yaml'
  if (ext === 'dart') return 'typescript'
  if (ext === 'diff' || ext === 'patch') return 'diff'

  if (name.startsWith('.git') || name === '.gitignore' || name === '.editorconfig' || name === '.npmrc') return 'shell'
  return 'plain'
}

const JS_KEYWORDS = new Set([
  'import', 'export', 'from', 'default', 'as', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'switch', 'case', 'break', 'continue', 'for', 'while', 'do', 'try', 'catch',
  'finally', 'throw', 'new', 'typeof', 'instanceof', 'void', 'delete', 'in', 'of', 'async',
  'await', 'yield', 'class', 'extends', 'super', 'this', 'interface', 'type', 'enum',
  'implements', 'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'override',
  'declare', 'namespace', 'module', 'require', 'debugger', 'is', 'keyof', 'infer', 'never', 'unknown',
  'final', 'late', 'required', 'factory', 'mixin', 'typedef', 'with'
])

const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'import', 'from', 'as', 'return', 'if', 'elif', 'else', 'for', 'while',
  'break', 'continue', 'try', 'except', 'finally', 'raise', 'with', 'yield', 'lambda',
  'pass', 'global', 'nonlocal', 'assert', 'del', 'async', 'await', 'in', 'is', 'not', 'and', 'or'
])

const PYTHON_CONSTANTS = new Set(['True', 'False', 'None'])

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'if', 'else',
  'for', 'while', 'loop', 'break', 'continue', 'return', 'use', 'mod', 'type', 'const',
  'static', 'async', 'await', 'move', 'where', 'as', 'in', 'ref', 'self', 'Self', 'dyn', 'crate'
])

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'group', 'by',
  'order', 'having', 'limit', 'offset', 'create', 'table', 'index', 'view', 'drop',
  'alter', 'add', 'column', 'primary', 'key', 'foreign', 'references', 'unique',
  'not', 'null', 'and', 'or', 'in', 'is', 'like', 'between', 'exists', 'case', 'when',
  'then', 'else', 'end', 'as', 'union', 'all', 'distinct', 'cascade'
])

const NUM_JSON_REGEX = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/
const TAG_REGEX = /^<\/?([a-zA-Z0-9_\-.]+)/
const NUM_CODE_REGEX = /^(0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?[\d_]+)?n?)/
const HUNK_REGEX = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Tokenizes a single line of text according to the target language.
 */
export function highlightLine(line: string, lang: string): HighlightedLine {
  if (!line) {
    return [{ text: '' }]
  }

  // 1. Diff Lines (standalone)
  if (lang === 'diff') {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      return [{ text: line, type: 'diff-header' }]
    }
    if (line.startsWith('@@')) {
      return [{ text: line, type: 'diff-hunk' }]
    }
    if (line.startsWith('+')) {
      return [{ text: line, type: 'diff-add' }]
    }
    if (line.startsWith('-')) {
      return [{ text: line, type: 'diff-del' }]
    }
    return [{ text: line, type: 'plain' }]
  }

  // 2. Markdown Lines
  if (lang === 'markdown') {
    if (/^#{1,6}\s+/.test(line)) {
      return [{ text: line, type: 'keyword' }]
    }
    if (/^>\s+/.test(line)) {
      return [{ text: line, type: 'comment' }]
    }
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx !== -1) {
        return [
          { text: line.slice(0, spaceIdx + 1), type: 'operator' },
          { text: line.slice(spaceIdx + 1), type: 'plain' },
        ]
      }
    }
    if (line.startsWith('```')) {
      return [{ text: line, type: 'comment' }]
    }
  }

  // 3. JSON Lines
  if (lang === 'json') {
    return tokenizeJsonLine(line)
  }

  // 4. General Lexical Tokenizer (TS/JS, Py, Rust, SQL, CSS, HTML, Shell, Dart)
  return tokenizeCodeLine(line, lang)
}

function tokenizeJsonLine(line: string): HighlightedLine {
  const tokens: TokenSpan[] = []
  let i = 0
  const len = line.length

  while (i < len) {
    const char = line.charAt(i)
    if (!char) break

    // Whitespace
    if (/\s/.test(char)) {
      let ws = ''
      while (i < len && /\s/.test(line.charAt(i))) {
        ws += line.charAt(i)
        i++
      }
      tokens.push({ text: ws })
      continue
    }

    // Comment (JSONC)
    if (line.startsWith('//', i) || line.startsWith('/*', i)) {
      tokens.push({ text: line.slice(i), type: 'comment' })
      break
    }

    // String / Property
    if (char === '"' || char === "'") {
      const quote = char
      let str = quote
      i++
      while (i < len && line.charAt(i) !== quote) {
        const c = line.charAt(i)
        if (c === '\\' && i + 1 < len) {
          str += c + line.charAt(i + 1)
          i += 2
        } else {
          str += c
          i++
        }
      }
      if (i < len) {
        str += line.charAt(i)
        i++
      }

      // If followed by ':', it's a property key
      let isKey = false
      let lookahead = i
      while (lookahead < len && /\s/.test(line.charAt(lookahead))) {
        lookahead++
      }
      if (lookahead < len && line.charAt(lookahead) === ':') {
        isKey = true
      }

      tokens.push({ text: str, type: isKey ? 'property' : 'string' })
      continue
    }

    // Numbers
    if (/[\d-]/.test(char)) {
      const match = NUM_JSON_REGEX.exec(line.slice(i))
      if (match?.[0]) {
        tokens.push({ text: match[0], type: 'number' })
        i += match[0].length
        continue
      }
    }

    // Booleans & Null
    if (line.startsWith('true', i)) {
      tokens.push({ text: 'true', type: 'constant' })
      i += 4
      continue
    }
    if (line.startsWith('false', i)) {
      tokens.push({ text: 'false', type: 'constant' })
      i += 5
      continue
    }
    if (line.startsWith('null', i)) {
      tokens.push({ text: 'null', type: 'constant' })
      i += 4
      continue
    }

    // Punctuation
    if ('{}[],:'.includes(char)) {
      tokens.push({ text: char, type: 'punct' })
      i++
      continue
    }

    tokens.push({ text: char, type: 'plain' })
    i++
  }

  return tokens
}

function tokenizeCodeLine(line: string, lang: string): HighlightedLine {
  const tokens: TokenSpan[] = []
  let i = 0
  const len = line.length

  while (i < len) {
    const char = line.charAt(i)
    if (!char) break

    // Whitespace
    if (/\s/.test(char)) {
      let ws = ''
      while (i < len && /\s/.test(line.charAt(i))) {
        ws += line.charAt(i)
        i++
      }
      tokens.push({ text: ws })
      continue
    }

    // Single-line comments
    if (line.startsWith('//', i) || (['python', 'shell', 'yaml'].includes(lang) && char === '#') || (lang === 'sql' && line.startsWith('--', i))) {
      tokens.push({ text: line.slice(i), type: 'comment' })
      break
    }

    // Block comments (single line portion)
    if (line.startsWith('/*', i)) {
      const endIdx = line.indexOf('*/', i + 2)
      if (endIdx !== -1) {
        tokens.push({ text: line.slice(i, endIdx + 2), type: 'comment' })
        i = endIdx + 2
        continue
      } else {
        tokens.push({ text: line.slice(i), type: 'comment' })
        break
      }
    }

    // HTML / JSX tags
    if (char === '<' && (lang === 'html' || lang === 'typescript' || lang === 'javascript')) {
      const tagMatch = TAG_REGEX.exec(line.slice(i))
      if (tagMatch?.[0]) {
        tokens.push({ text: tagMatch[0], type: 'tag' })
        i += tagMatch[0].length
        continue
      }
    }

    // Strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      let str = quote
      i++
      while (i < len && line.charAt(i) !== quote) {
        const c = line.charAt(i)
        if (c === '\\' && i + 1 < len) {
          str += c + line.charAt(i + 1)
          i += 2
        } else {
          str += c
          i++
        }
      }
      if (i < len) {
        str += line.charAt(i)
        i++
      }
      tokens.push({ text: str, type: 'string' })
      continue
    }

    // Numbers
    if (/\d/.test(char)) {
      const numMatch = NUM_CODE_REGEX.exec(line.slice(i))
      if (numMatch?.[0]) {
        tokens.push({ text: numMatch[0], type: 'number' })
        i += numMatch[0].length
        continue
      }
    }

    // Identifiers, Keywords, Functions, Types
    if (/[a-zA-Z_$]/.test(char)) {
      let word = ''
      while (i < len && /[a-zA-Z0-9_$]/.test(line.charAt(i))) {
        word += line.charAt(i)
        i++
      }

      // Check language keywords
      let type: TokenType | undefined = undefined
      const lower = word.toLowerCase()

      if (lang === 'typescript' || lang === 'javascript') {
        if (JS_KEYWORDS.has(word)) type = 'keyword'
        else if (JS_CONSTANTS.has(word)) type = 'constant'
        else if (/^[A-Z][a-zA-Z0-9_$]*$/.test(word)) type = 'type'
      } else if (lang === 'python') {
        if (PYTHON_KEYWORDS.has(word)) type = 'keyword'
        else if (PYTHON_CONSTANTS.has(word)) type = 'constant'
        else if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) type = 'type'
      } else if (lang === 'rust') {
        if (RUST_KEYWORDS.has(word)) type = 'keyword'
        else if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) type = 'type'
      } else if (lang === 'sql') {
        if (SQL_KEYWORDS.has(lower)) type = 'keyword'
      }

      // Check if followed by '(' -> function call
      if (!type) {
        let look = i
        while (look < len && /\s/.test(line.charAt(look))) look++
        if (look < len && line.charAt(look) === '(') {
          type = 'function'
        }
      }

      tokens.push({ text: word, type: type ?? 'plain' })
      continue
    }

    // Operators and Punctuation
    if ('=+-*/%&|^!~?:<>'.includes(char)) {
      tokens.push({ text: char, type: 'operator' })
      i++
      continue
    }

    if ('(){}[];,.:'.includes(char)) {
      tokens.push({ text: char, type: 'punct' })
      i++
      continue
    }

    // Fallback single character
    tokens.push({ text: char, type: 'plain' })
    i++
  }

  return tokens
}

/**
 * Tokenizes multi-line code into a matrix of highlighted token spans per line.
 */
export function highlightCode(code: string, filePathOrLang: string): readonly HighlightedLine[] {
  const lang = filePathOrLang.includes('/') || filePathOrLang.includes('.')
    ? detectLanguage(filePathOrLang)
    : filePathOrLang

  const lines = code.split('\n')
  return lines.map((line) => highlightLine(line, lang))
}

/**
 * Parses unified diff patch text into structured lines with line numbers and syntax tokenization.
 */
export function parseDiffLines(patch: string, filePathOrLang: string): readonly ParsedDiffLine[] {
  const targetLang = filePathOrLang.includes('/') || filePathOrLang.includes('.')
    ? detectLanguage(filePathOrLang)
    : filePathOrLang

  const rawLines = patch.split('\n')
  const result: ParsedDiffLine[] = []

  let currentOld = 1
  let currentNew = 1

  for (const line of rawLines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('Binary files ')
    ) {
      result.push({
        type: 'header',
        text: line,
        oldLineNumber: null,
        newLineNumber: null,
        tokens: [{ text: line, type: 'diff-header' }],
      })
      continue
    }

    if (line.startsWith('@@')) {
      const match = HUNK_REGEX.exec(line)
      if (match) {
        currentOld = Number(match[1])
        currentNew = Number(match[2])
        const context = match[3]?.trim() ?? ''
        result.push({
          type: 'hunk',
          text: line,
          oldLineNumber: null,
          newLineNumber: null,
          tokens: [{ text: line, type: 'diff-hunk' }],
          hunkInfo: context,
        })
      } else {
        result.push({
          type: 'hunk',
          text: line,
          oldLineNumber: null,
          newLineNumber: null,
          tokens: [{ text: line, type: 'diff-hunk' }],
        })
      }
      continue
    }

    if (line.startsWith('+')) {
      const codePart = line.slice(1)
      const tokens = highlightLine(codePart, targetLang)
      result.push({
        type: 'add',
        text: codePart,
        oldLineNumber: null,
        newLineNumber: currentNew++,
        tokens,
      })
      continue
    }

    if (line.startsWith('-')) {
      const codePart = line.slice(1)
      const tokens = highlightLine(codePart, targetLang)
      result.push({
        type: 'del',
        text: codePart,
        oldLineNumber: currentOld++,
        newLineNumber: null,
        tokens,
      })
      continue
    }

    if (line.startsWith(' ')) {
      const codePart = line.slice(1)
      const tokens = highlightLine(codePart, targetLang)
      result.push({
        type: 'context',
        text: codePart,
        oldLineNumber: currentOld++,
        newLineNumber: currentNew++,
        tokens,
      })
      continue
    }

    // Trailing newline or non-standard diff line
    if (!line.trim()) {
      continue
    }

    result.push({
      type: 'context',
      text: line,
      oldLineNumber: currentOld++,
      newLineNumber: currentNew++,
      tokens: highlightLine(line, targetLang),
    })
  }

  return result
}

/**
 * Builds aligned side-by-side (split) diff rows from parsed diff lines.
 */
export function buildSplitDiff(parsedLines: readonly ParsedDiffLine[]): readonly SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let pendingDels: ParsedDiffLine[] = []
  let pendingAdds: ParsedDiffLine[] = []

  function flushPending() {
    const count = Math.max(pendingDels.length, pendingAdds.length)
    for (let i = 0; i < count; i++) {
      const del = pendingDels[i]
      const add = pendingAdds[i]

      rows.push({
        oldLine: del
          ? { lineNumber: del.oldLineNumber, type: 'del', tokens: del.tokens }
          : { lineNumber: null, type: 'empty', tokens: [{ text: '' }] },
        newLine: add
          ? { lineNumber: add.newLineNumber, type: 'add', tokens: add.tokens }
          : { lineNumber: null, type: 'empty', tokens: [{ text: '' }] },
      })
    }
    pendingDels = []
    pendingAdds = []
  }

  for (const line of parsedLines) {
    if (line.type === 'header') {
      continue
    }

    if (line.type === 'hunk') {
      flushPending()
      rows.push({
        isHunk: true,
        hunkText: line.text,
        hunkInfo: line.hunkInfo,
      })
      continue
    }

    if (line.type === 'del') {
      pendingDels.push(line)
      continue
    }

    if (line.type === 'add') {
      pendingAdds.push(line)
      continue
    }

    flushPending()
    rows.push({
      oldLine: { lineNumber: line.oldLineNumber, type: 'context', tokens: line.tokens },
      newLine: { lineNumber: line.newLineNumber, type: 'context', tokens: line.tokens },
    })
  }

  flushPending()
  return rows
}

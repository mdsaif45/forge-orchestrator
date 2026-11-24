/**
 * Unified diff changeset chunk formatter and ANSI colorizer.
 *
 * Parses unified diff headers, hunks, additions, deletions, and context lines,
 * computing accurate line-number gutters and ANSI terminal highlights with
 * fail-closed clean rendering support (A1, A3).
 */

export type LineChunkType = 'header' | 'hunk_meta' | 'context' | 'addition' | 'deletion'

export interface HighlightedDiffLine {
  readonly lineType: LineChunkType
  readonly oldLineNumber?: number | undefined
  readonly newLineNumber?: number | undefined
  readonly rawContent: string
  readonly ansiContent: string
  readonly cleanContent: string
}

export interface DiffHighlightReport {
  readonly filePath?: string | undefined
  readonly hunksCount: number
  readonly additionsCount: number
  readonly deletionsCount: number
  readonly linesCount: number
  readonly lines: readonly HighlightedDiffLine[]
  readonly renderedAnsi: string
  readonly renderedClean: string
}

export interface HighlighterOptions {
  /** Whether to format and include line number gutters. Defaults to true. */
  readonly includeLineNumbers?: boolean | undefined
  /** Whether ANSI terminal escape codes are enabled. Defaults to true. */
  readonly colorEnabled?: boolean | undefined
  /** Minimum character width for line number gutters. Defaults to 4. */
  readonly gutterWidth?: number | undefined
}

const ANSI_RESET = '\x1b[0m'
const ANSI_HEADER = '\x1b[1;35m' // Bold magenta
const ANSI_HUNK = '\x1b[36m' // Cyan
const ANSI_ADD = '\x1b[32m' // Green
const ANSI_DEL = '\x1b[31m' // Red
const ANSI_GUTTER = '\x1b[90m' // Dim / Gray

/* eslint-disable no-control-regex */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g
/* eslint-enable no-control-regex */

export class ChangesetChunkAnsiHighlighter {
  /**
   * Strips all ANSI escape sequences from a string.
   */
  static stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '')
  }

  /**
   * Parses and highlights a raw unified diff patch or hunk string.
   */
  highlight(rawDiff: string, options: HighlighterOptions = {}): DiffHighlightReport {
    const includeLineNumbers = options.includeLineNumbers ?? true
    const colorEnabled = options.colorEnabled ?? true
    const gutterWidth = Math.max(2, options.gutterWidth ?? 4)

    const rawLines = rawDiff.split(/\r?\n/)
    // Drop trailing empty element if rawDiff ends with newline
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop()
    }

    let detectedFilePath: string | undefined
    let hunksCount = 0
    let additionsCount = 0
    let deletionsCount = 0

    let currentOldLine = 0
    let currentNewLine = 0
    let inHunk = false

    const processedLines: HighlightedDiffLine[] = []

    for (const rawLine of rawLines) {
      // 1. Detect file headers
      if (
        rawLine.startsWith('diff --git ') ||
        rawLine.startsWith('index ') ||
        rawLine.startsWith('--- ') ||
        rawLine.startsWith('+++ ')
      ) {
        if (rawLine.startsWith('diff --git ')) {
          const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(rawLine)
          if (match?.[2]) {
            detectedFilePath = match[2]
          }
        } else if (rawLine.startsWith('+++ b/')) {
          detectedFilePath = rawLine.slice(6).trim()
        }

        const gutter = includeLineNumbers ? this.formatEmptyGutter(gutterWidth) : ''
        const cleanContent = `${gutter}${rawLine}`
        const ansiContent = colorEnabled
          ? `${gutter}${ANSI_HEADER}${rawLine}${ANSI_RESET}`
          : cleanContent

        processedLines.push({
          lineType: 'header',
          rawContent: rawLine,
          ansiContent,
          cleanContent,
        })
        continue
      }

      // 2. Detect hunk metadata: @@ -oldStart,oldLen +newStart,newLen @@
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(rawLine)
      if (hunkMatch?.[1] && hunkMatch[2]) {
        hunksCount += 1
        currentOldLine = parseInt(hunkMatch[1], 10)
        currentNewLine = parseInt(hunkMatch[2], 10)
        inHunk = true

        const gutter = includeLineNumbers ? this.formatEmptyGutter(gutterWidth) : ''
        const cleanContent = `${gutter}${rawLine}`
        const ansiContent = colorEnabled
          ? `${gutter}${ANSI_HUNK}${rawLine}${ANSI_RESET}`
          : cleanContent

        processedLines.push({
          lineType: 'hunk_meta',
          rawContent: rawLine,
          ansiContent,
          cleanContent,
        })
        continue
      }

      // 3. Process diff body lines (additions, deletions, context)
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        additionsCount += 1
        const lineNum = inHunk ? currentNewLine : undefined
        if (inHunk) currentNewLine += 1

        const gutterClean = includeLineNumbers
          ? this.formatGutter(undefined, lineNum, gutterWidth, false)
          : ''
        const gutterAnsi =
          includeLineNumbers && colorEnabled
            ? this.formatGutter(undefined, lineNum, gutterWidth, true)
            : gutterClean

        const cleanContent = `${gutterClean}${rawLine}`
        const ansiContent = colorEnabled
          ? `${gutterAnsi}${ANSI_ADD}${rawLine}${ANSI_RESET}`
          : cleanContent

        processedLines.push({
          lineType: 'addition',
          newLineNumber: lineNum,
          rawContent: rawLine,
          ansiContent,
          cleanContent,
        })
      } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
        deletionsCount += 1
        const lineNum = inHunk ? currentOldLine : undefined
        if (inHunk) currentOldLine += 1

        const gutterClean = includeLineNumbers
          ? this.formatGutter(lineNum, undefined, gutterWidth, false)
          : ''
        const gutterAnsi =
          includeLineNumbers && colorEnabled
            ? this.formatGutter(lineNum, undefined, gutterWidth, true)
            : gutterClean

        const cleanContent = `${gutterClean}${rawLine}`
        const ansiContent = colorEnabled
          ? `${gutterAnsi}${ANSI_DEL}${rawLine}${ANSI_RESET}`
          : cleanContent

        processedLines.push({
          lineType: 'deletion',
          oldLineNumber: lineNum,
          rawContent: rawLine,
          ansiContent,
          cleanContent,
        })
      } else {
        // Context line
        const oldNum = inHunk ? currentOldLine : undefined
        const newNum = inHunk ? currentNewLine : undefined
        if (inHunk) {
          currentOldLine += 1
          currentNewLine += 1
        }

        const gutterClean = includeLineNumbers
          ? this.formatGutter(oldNum, newNum, gutterWidth, false)
          : ''
        const gutterAnsi =
          includeLineNumbers && colorEnabled
            ? this.formatGutter(oldNum, newNum, gutterWidth, true)
            : gutterClean

        const cleanContent = `${gutterClean}${rawLine}`
        const ansiContent = `${gutterAnsi}${rawLine}`

        processedLines.push({
          lineType: 'context',
          oldLineNumber: oldNum,
          newLineNumber: newNum,
          rawContent: rawLine,
          ansiContent,
          cleanContent,
        })
      }
    }

    const renderedAnsi = processedLines.map((l) => l.ansiContent).join('\n')
    const renderedClean = processedLines.map((l) => l.cleanContent).join('\n')

    return {
      filePath: detectedFilePath,
      hunksCount,
      additionsCount,
      deletionsCount,
      linesCount: processedLines.length,
      lines: processedLines,
      renderedAnsi,
      renderedClean,
    }
  }

  private formatGutter(
    oldNum: number | undefined,
    newNum: number | undefined,
    width: number,
    colorEnabled: boolean,
  ): string {
    const oldStr = oldNum !== undefined ? String(oldNum).padStart(width, ' ') : ' '.repeat(width)
    const newStr = newNum !== undefined ? String(newNum).padStart(width, ' ') : ' '.repeat(width)

    if (colorEnabled) {
      return `${ANSI_GUTTER}${oldStr} | ${newStr} |${ANSI_RESET} `
    }
    return `${oldStr} | ${newStr} | `
  }

  private formatEmptyGutter(width: number): string {
    const blank = ' '.repeat(width)
    return `${blank} | ${blank} | `
  }
}

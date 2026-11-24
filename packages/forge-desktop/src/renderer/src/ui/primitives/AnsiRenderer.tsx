import React from 'react'

export interface AnsiRendererProps {
  readonly text: string
  readonly className?: string | undefined
}

interface AnsiSpan {
  readonly text: string
  readonly color?: string | undefined
  readonly bgColor?: string | undefined
  readonly bold?: boolean | undefined
  readonly dim?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: '#1e293b', // Black
  31: '#ef4444', // Red
  32: '#10b981', // Green
  33: '#f59e0b', // Yellow
  34: '#3b82f6', // Blue
  35: '#a855f7', // Magenta
  36: '#06b6d4', // Cyan
  37: '#e2e8f0', // White
  90: '#64748b', // Bright Black / Gray
  91: '#f87171', // Bright Red
  92: '#34d399', // Bright Green
  93: '#fbbf24', // Bright Yellow
  94: '#60a5fa', // Bright Blue
  95: '#c084fc', // Bright Magenta
  96: '#22d3ee', // Bright Cyan
  97: '#ffffff', // Bright White
}

const ANSI_BG_COLOR_MAP: Record<number, string> = {
  40: '#0f172a',
  41: '#7f1d1d',
  42: '#064e3b',
  43: '#78350f',
  44: '#1e3a8a',
  45: '#581c87',
  46: '#164e63',
  47: '#334155',
}

export function parseAnsi(text: string): readonly AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let currentColor: string | undefined
  let currentBgColor: string | undefined
  let currentBold = false
  let currentDim = false
  let currentItalic = false
  let currentUnderline = false

  // Regex to match ANSI escape codes e.g. \x1b[31m, \x1b[1;32m, \u001b[0m
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let match: RegExpExecArray | null = ansiRegex.exec(text)

  while (match !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index)
      if (segment.length > 0) {
        spans.push({
          text: segment,
          color: currentColor,
          bgColor: currentBgColor,
          bold: currentBold,
          dim: currentDim,
          italic: currentItalic,
          underline: currentUnderline,
        })
      }
    }

    const codeStr = match[1] ?? '0'
    const codes = codeStr === '' ? [0] : codeStr.split(';').map((c) => parseInt(c, 10))

    for (const code of codes) {
      if (code === 0) {
        // Reset all styles
        currentColor = undefined
        currentBgColor = undefined
        currentBold = false
        currentDim = false
        currentItalic = false
        currentUnderline = false
      } else if (code === 1) {
        currentBold = true
      } else if (code === 2) {
        currentDim = true
      } else if (code === 3) {
        currentItalic = true
      } else if (code === 4) {
        currentUnderline = true
      } else if (code === 22) {
        currentBold = false
        currentDim = false
      } else if (code === 23) {
        currentItalic = false
      } else if (code === 24) {
        currentUnderline = false
      } else if (ANSI_COLOR_MAP[code] !== undefined) {
        currentColor = ANSI_COLOR_MAP[code]
      } else if (ANSI_BG_COLOR_MAP[code] !== undefined) {
        currentBgColor = ANSI_BG_COLOR_MAP[code]
      } else if (code === 39) {
        currentColor = undefined
      } else if (code === 49) {
        currentBgColor = undefined
      }
    }

    lastIndex = match.index + match[0].length
    match = ansiRegex.exec(text)
  }

  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex)
    if (trailing.length > 0) {
      spans.push({
        text: trailing,
        color: currentColor,
        bgColor: currentBgColor,
        bold: currentBold,
        dim: currentDim,
        italic: currentItalic,
        underline: currentUnderline,
      })
    }
  }

  return spans
}

export function AnsiRenderer({ text, className }: AnsiRendererProps): React.JSX.Element {
  const spans = parseAnsi(text)

  return (
    <span className={`whitespace-pre-wrap font-mono ${className ?? ''}`}>
      {spans.map((span, index) => {
        const style: React.CSSProperties = {}
        if (span.color) style.color = span.color
        if (span.bgColor) style.backgroundColor = span.bgColor
        if (span.bold) style.fontWeight = 'bold'
        if (span.dim) style.opacity = 0.7
        if (span.italic) style.fontStyle = 'italic'
        if (span.underline) style.textDecoration = 'underline'

        return (
          <span key={`span-${String(index)}`} style={style}>
            {span.text}
          </span>
        )
      })}
    </span>
  )
}

import React from 'react'

export interface MarkdownRendererProps {
  readonly content: string
  readonly className?: string | undefined
}

const BOLD_REGEX = /^(\*\*|__)(.*?)\1/
const CODE_REGEX = /^`([^`]+)`/
const NUM_REGEX = /^(\d+)\.\s+(.*)$/

export function MarkdownRenderer({ content, className }: MarkdownRendererProps): React.JSX.Element {
  const lines = content.split('\n')
  const elements: React.JSX.Element[] = []

  let inCodeBlock = false
  let codeBlockLang = ''
  let codeBlockLines: string[] = []
  let codeBlockKey = 0

  const renderInline = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = []
    let remaining = text

    let key = 0
    while (remaining.length > 0) {
      // Bold match
      const boldMatch = BOLD_REGEX.exec(remaining)
      if (boldMatch?.[2] !== undefined) {
        parts.push(
          <strong key={`b-${String(key++)}`} className="font-semibold text-(--color-text)">
            {renderInline(boldMatch[2])}
          </strong>,
        )
        remaining = remaining.slice(boldMatch[0].length)
        continue
      }

      // Inline code match
      const codeMatch = CODE_REGEX.exec(remaining)
      if (codeMatch?.[1] !== undefined) {
        parts.push(
          <code
            key={`c-${String(key++)}`}
            className="rounded bg-(--color-surface-inset) border border-(--color-border) px-1.5 py-0.5 font-mono text-[11px] text-(--color-accent)"
          >
            {codeMatch[1]}
          </code>,
        )
        remaining = remaining.slice(codeMatch[0].length)
        continue
      }

      // Plain text up to next special char
      const nextSpecial = remaining.search(/(\*\*|__|`)/)
      if (nextSpecial === -1) {
        parts.push(remaining)
        break
      } else if (nextSpecial === 0) {
        parts.push(remaining[0])
        remaining = remaining.slice(1)
      } else {
        parts.push(remaining.slice(0, nextSpecial))
        remaining = remaining.slice(nextSpecial)
      }
    }

    return parts
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const fullCode = codeBlockLines.join('\n')
        elements.push(
          <div
            key={`cb-${String(codeBlockKey++)}`}
            className="my-2 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface-inset)"
          >
            <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised) px-3 py-1 text-[10px] font-mono text-(--color-text-subtle)">
              <span>{codeBlockLang || 'code'}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(fullCode)
                }}
                className="hover:text-(--color-text) cursor-pointer"
              >
                Copy
              </button>
            </div>
            <pre className="p-3 font-mono text-[11px] leading-relaxed overflow-x-auto text-(--color-text)">
              <code>{fullCode}</code>
            </pre>
          </div>,
        )
        codeBlockLines = []
        inCodeBlock = false
        codeBlockLang = ''
      } else {
        inCodeBlock = true
        codeBlockLang = line.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // Headers
    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={`h4-${String(i)}`} className="mt-3 mb-1 text-[13px] font-bold text-(--color-text)">
          {renderInline(line.slice(4))}
        </h4>,
      )
      continue
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={`h3-${String(i)}`} className="mt-3 mb-1 text-[14px] font-bold text-(--color-text)">
          {renderInline(line.slice(3))}
        </h3>,
      )
      continue
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={`h2-${String(i)}`} className="mt-3 mb-1.5 text-[15px] font-bold text-(--color-text)">
          {renderInline(line.slice(2))}
        </h2>,
      )
      continue
    }

    // Bullet points
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <li key={`li-${String(i)}`} className="ml-4 list-disc text-[12px] leading-relaxed text-(--color-text)">
          {renderInline(line.slice(2))}
        </li>,
      )
      continue
    }

    // Numbered list
    const numMatch = NUM_REGEX.exec(line)
    if (numMatch?.[2] !== undefined) {
      elements.push(
        <div key={`num-${String(i)}`} className="ml-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-(--color-text)">
          <span className="font-semibold text-(--color-text-muted)">{numMatch[1]}.</span>
          <span>{renderInline(numMatch[2])}</span>
        </div>,
      )
      continue
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={`sp-${String(i)}`} className="h-1.5" />)
      continue
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${String(i)}`} className="m-0 text-[12px] leading-relaxed text-(--color-text)">
        {renderInline(line)}
      </p>,
    )
  }

  return <div className={`space-y-0.5 ${className ?? ''}`}>{elements}</div>
}

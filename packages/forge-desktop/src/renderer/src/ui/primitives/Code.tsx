import { cn } from '../cn'

/**
 * Monospace text.
 *
 * A primitive rather than an inline class because Forge shows machine output
 * constantly — file paths, SHAs, commands, exit codes — and they should all look
 * identical wherever they appear.
 */
export function Code({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <code
      className={cn(
        'rounded-(--radius-sm) bg-(--color-surface-inset) px-1 py-0.5',
        'font-(family-name:--font-mono) text-(length:--text-xs) text-(--color-text)',
        className,
      )}
      {...props}
    />
  )
}

export interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  /** Renders gutter line numbers, matching the diff viewer's conventions. */
  readonly showLineNumbers?: boolean
  readonly children: string
}

export function CodeBlock({
  className,
  showLineNumbers = false,
  children,
  ...props
}: CodeBlockProps): React.JSX.Element {
  const lines = children.split('\n')

  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-(--radius-md) border border-(--color-border)',
        'bg-(--color-surface-inset) p-3',
        'font-(family-name:--font-mono) text-(length:--text-xs) leading-relaxed text-(--color-text)',
        className,
      )}
      {...props}
    >
      {showLineNumbers ? (
        <code className="grid grid-cols-[auto_1fr] gap-x-3">
          {lines.map((line, index) => (
            // Line position is the identity here; there is no stabler key.
            <span key={index} className="contents">
              <span className="text-right tabular-nums text-(--color-text-subtle) select-none">
                {index + 1}
              </span>
              <span className="whitespace-pre">{line}</span>
            </span>
          ))}
        </code>
      ) : (
        <code className="whitespace-pre">{children}</code>
      )}
    </pre>
  )
}

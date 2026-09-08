import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export interface MarkdownRendererProps {
  readonly content: string
  readonly className?: string | undefined
}

/**
 * Markdown for agent and model output.
 *
 * This was 187 lines of hand-rolled, line-at-a-time regex. It covered bold,
 * inline code, three heading levels, bullets, numbered lists and fenced blocks —
 * and silently dropped everything else, because an unrecognised line fell
 * through to a paragraph. Measured against a real local-model reply: a GFM table
 * rendered as pipe characters in prose, ```bash and ```json blocks rendered as
 * undifferentiated grey text, and links, blockquotes and nested lists did not
 * render at all.
 *
 * Replaced with `react-markdown` because the failure mode of a partial
 * implementation is invisible: it produces plausible-looking output while losing
 * structure, which is the same class of problem as a pane that reports a status
 * it never measured.
 *
 * ```
 * remark-gfm        tables, task lists, strikethrough, autolinks
 * rehype-highlight  syntax highlighting, language taken from the fence
 * ```
 *
 * The grammar set is left at lowlight's `common` (37 languages, bash/json/ts
 * among them). Narrowing it was tried and made the bundle BIGGER — measured
 * 2,670 kB to 2,783 kB — because `rehype-highlight` imports `common` statically,
 * so its `languages` option changes what is registered at runtime and not what
 * is bundled. Explicit grammars are therefore additive, never a replacement.
 *
 * Model output is untrusted, so raw HTML is deliberately NOT enabled
 * (no `rehype-raw`). `react-markdown` builds a React tree and escapes HTML by
 * default; the production CSP also forbids inline script, so both layers have to
 * fail before markup in a reply could execute.
 *
 * Everything is selectable: `styles.css` sets `user-select: none` on the body so
 * the app does not feel like a web page, which had the side effect that a reply
 * could be read but never copied. The wrapper opts this subtree back in.
 */
export function MarkdownRenderer({ content, className }: MarkdownRendererProps): React.JSX.Element {
  return (
    <div className={`forge-markdown ${className ?? ''}`} data-selectable>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // A wide table must scroll inside its own box. Without this the whole
          // conversation column widens and the layout breaks sideways.
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-(--color-border)">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-(--color-border) bg-(--color-surface-raised) px-3 py-1.5 text-left font-semibold text-(--color-text)">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-(--color-border) px-3 py-1.5 align-top text-(--color-text)">
              {children}
            </td>
          ),
          // `pre` carries the block; the `code` inside it keeps the language class
          // that rehype-highlight added, so it must not be restyled as inline code.
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className: codeClass, children }) => {
            const isBlock = codeClass?.includes('language-') === true
            if (isBlock) {
              return <code className={codeClass}>{children}</code>
            }
            return (
              <code className="rounded border border-(--color-border) bg-(--color-surface-inset) px-1.5 py-0.5 font-mono text-[11px] text-(--color-accent)">
                {children}
              </code>
            )
          },
          a: ({ href, children }) => (
            // Opened by the main process, not the renderer: `lockWindowNavigation`
            // routes an external URL to the OS browser and blocks in-page
            // navigation, so a link in model output cannot move the app off its
            // own origin.
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-(--color-accent) underline underline-offset-2"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h2 className="mt-3 mb-1.5 text-[15px] font-bold text-(--color-text)">{children}</h2>
          ),
          h2: ({ children }) => (
            <h3 className="mt-3 mb-1 text-[14px] font-bold text-(--color-text)">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="mt-3 mb-1 text-[13px] font-bold text-(--color-text)">{children}</h4>
          ),
          p: ({ children }) => (
            <p className="my-1.5 text-[12px] leading-relaxed text-(--color-text)">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 ml-5 list-disc space-y-0.5 text-[12px] leading-relaxed text-(--color-text)">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 ml-5 list-decimal space-y-0.5 text-[12px] leading-relaxed text-(--color-text)">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-(--color-accent) pl-3 text-[12px] italic text-(--color-text-muted)">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-(--color-border)" />,
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}

/**
 * A fenced block with its own copy button.
 *
 * The button predates the selection fix and is kept: copying a whole snippet in
 * one click is faster than selecting it, and it is what the rest of the app does.
 * The text comes from the rendered DOM rather than the source string because the
 * component receives an already-parsed React tree here.
 */
function CodeBlock({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  const [copied, setCopied] = React.useState(false)

  const copy = (): void => {
    const text = ref.current?.innerText ?? ''
    if (text === '') return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        // Reverts on its own so the label does not stay wrong after the next copy.
        setTimeout(() => {
          setCopied(false)
        }, 1200)
      })
      .catch(() => {
        // A denied clipboard is the user's setting, not an app failure. The text
        // is selectable, so there is still a way to copy it.
      })
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface-inset)">
      <div className="flex items-center justify-end border-b border-(--color-border) bg-(--color-surface-raised) px-3 py-1">
        <button
          type="button"
          onClick={copy}
          className="cursor-pointer font-mono text-[10px] text-(--color-text-subtle) hover:text-(--color-text)"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        ref={ref}
        className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-(--color-text)"
      >
        {children}
      </pre>
    </div>
  )
}

import type { JSX } from 'react'
import { cn } from '../cn'

export interface FileIconProps {
  readonly fileName: string
  readonly isFolder?: boolean | undefined
  readonly isOpen?: boolean | undefined
  readonly className?: string | undefined
}

export function FolderChevron({
  isOpen,
  className,
}: {
  readonly isOpen: boolean
  readonly className?: string | undefined
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        'size-3.5 shrink-0 transition-transform duration-100 text-(--color-text-muted)',
        isOpen ? 'rotate-90 text-(--color-text)' : '',
        className,
      )}
      aria-hidden="true"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  )
}

export function FileIcon({
  fileName,
  isFolder = false,
  isOpen = false,
  className,
}: FileIconProps): JSX.Element {
  const iconClass = cn('size-4 shrink-0', className)

  if (isFolder) {
    if (isOpen) {
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          className={cn(iconClass, 'text-(--color-syntax-type)')}
          aria-hidden="true"
        >
          <path
            d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.293a1 1 0 0 1 .707.293L8.414 3.7a1 1 0 0 0 .707.3H13A1.5 1.5 0 0 1 14.5 5.5v1M1.5 7h13l-1.3 6.5a1.5 1.5 0 0 1-1.47 1.2H2.27a1.5 1.5 0 0 1-1.47-1.2L1.5 7Z"
            fill="currentColor"
            fillOpacity="0.2"
          />
        </svg>
      )
    }

    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        className={cn(iconClass, 'text-(--color-syntax-type)')}
        aria-hidden="true"
      >
        <path
          d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.293a1 1 0 0 1 .707.293L8.414 3.7a1 1 0 0 0 .707.3H13A1.5 1.5 0 0 1 14.5 5.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Z"
          fill="currentColor"
          fillOpacity="0.2"
        />
      </svg>
    )
  }

  const name = fileName.toLowerCase()
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''

  // 1. TypeScript & TSX
  if (name.endsWith('.d.ts')) {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center rounded-(--radius-sm) bg-[#3178c6]/20 text-[9px] font-bold text-[#3178c6]',
        )}
      >
        D
      </span>
    )
  }
  if (ext === 'ts') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center rounded-(--radius-sm) bg-[#3178c6]/20 text-[9px] font-bold text-[#3178c6]',
        )}
      >
        TS
      </span>
    )
  }
  if (ext === 'tsx') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center rounded-(--radius-sm) bg-[#00d8ff]/20 text-[8px] font-bold text-[#00d8ff]',
        )}
      >
        ⚛
      </span>
    )
  }

  // 2. JavaScript & JSX
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center rounded-(--radius-sm) bg-[#f7df1e]/20 text-[9px] font-bold text-[#f7df1e]',
        )}
      >
        JS
      </span>
    )
  }
  if (ext === 'jsx') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center rounded-(--radius-sm) bg-[#f7df1e]/20 text-[8px] font-bold text-[#f7df1e]',
        )}
      >
        ⚛
      </span>
    )
  }

  // 3. JSON & Configurations
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[10px] font-bold text-[#cbcb41]',
        )}
      >
        {'{ }'}
      </span>
    )
  }
  if (ext === 'yml' || ext === 'yaml' || ext === 'toml') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#cb171e]',
        )}
      >
        ⚙
      </span>
    )
  }

  // 4. Styles & HTML
  if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[10px] font-bold text-[#42a5f5]',
        )}
      >
        #
      </span>
    )
  }
  if (ext === 'html' || ext === 'htm') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#e44d26]',
        )}
      >
        &lt;&gt;
      </span>
    )
  }

  // 5. Markdown & Documentation
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className={cn(iconClass, 'text-(--color-syntax-function)')}
        aria-hidden="true"
      >
        <path d="M14 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1ZM3 11V5h1.5l1.5 2 1.5-2H9v6H7.5V7.5L6 9.5 4.5 7.5V11H3Zm8 0-2-3h1.5V5h1v3H13l-2 3Z" />
      </svg>
    )
  }

  // 6. Python, Rust, Go, SQL
  if (ext === 'py') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#3776ab]',
        )}
      >
        Py
      </span>
    )
  }
  if (ext === 'rs') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#dea584]',
        )}
      >
        🦀
      </span>
    )
  }
  if (ext === 'go') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#00add8]',
        )}
      >
        Go
      </span>
    )
  }
  if (ext === 'sql' || ext === 'sqlite' || ext === 'db') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={cn(iconClass, 'text-(--color-syntax-property)')}
        aria-hidden="true"
      >
        <ellipse cx="8" cy="4" rx="6" ry="2.5" />
        <path d="M2 4v8c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V4" />
        <path d="M2 8c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5" />
      </svg>
    )
  }

  // 7. Shell & Scripts
  if (
    ext === 'sh' ||
    ext === 'bash' ||
    ext === 'zsh' ||
    ext === 'ps1' ||
    ext === 'bat' ||
    ext === 'cmd'
  ) {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-mono font-bold text-(--color-success)',
        )}
      >
        $_
      </span>
    )
  }

  // 8. Images
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico', 'bmp'].includes(ext)) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        className={cn(iconClass, 'text-[#d38aea]')}
        aria-hidden="true"
      >
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <circle cx="5.5" cy="5.5" r="1.5" />
        <path d="m14 10-3.5-3.5-6.5 6.5" />
      </svg>
    )
  }

  // 9. Special dotfiles
  if (name.startsWith('.git') || name === '.gitignore') {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#f05032]',
        )}
      >
        git
      </span>
    )
  }
  if (name.includes('license')) {
    return (
      <span
        className={cn(
          iconClass,
          'flex items-center justify-center text-[9px] font-bold text-[#d29922]',
        )}
      >
        §
      </span>
    )
  }

  // Default code / file icon
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      className={cn(iconClass, 'text-(--color-text-subtle)')}
      aria-hidden="true"
    >
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5.086a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V13.5A1.5 1.5 0 0 1 12.5 15h-8A1.5 1.5 0 0 1 3 13.5v-11Z" />
      <path d="M9.5 1v3.5A1 1 0 0 0 10.5 5.5H14" />
    </svg>
  )
}

import { cva, type VariantProps } from 'class-variance-authority'
import { Icon } from '../icons/Icon'
import type { ForgeIconName } from '../icons/registry'
import { cn } from '../lib/cn'
import { IconButton } from './IconButton'

const alertVariants = cva(
  'flex items-start gap-2.5 rounded-(--radius-lg) border px-3.5 py-2.5 text-(--color-text)',
  {
    variants: {
      tone: {
        info: 'border-(--color-info)/35 bg-(--color-info-muted)',
        success: 'border-(--color-success)/35 bg-(--color-success-muted)',
        warning: 'border-(--color-warning)/40 bg-(--color-warning-muted)',
        danger: 'border-(--color-danger)/40 bg-(--color-danger-muted)',
      },
    },
    defaultVariants: { tone: 'info' },
  },
)

const TONE_ICON: Record<NonNullable<VariantProps<typeof alertVariants>['tone']>, ForgeIconName> = {
  info: 'info',
  success: 'status-pass',
  warning: 'alert',
  danger: 'error',
}

const TONE_ICON_COLOR: Record<NonNullable<VariantProps<typeof alertVariants>['tone']>, string> = {
  info: 'text-(--color-info)',
  success: 'text-(--color-success)',
  warning: 'text-(--color-warning)',
  danger: 'text-(--color-danger)',
}

export interface AlertBannerProps extends VariantProps<typeof alertVariants> {
  readonly title: string
  readonly description?: string | undefined
  readonly action?: React.ReactNode | undefined
  readonly onDismiss?: (() => void) | undefined
  readonly className?: string | undefined
}

export function AlertBanner({
  tone = 'info',
  title,
  description,
  action,
  onDismiss,
  className,
}: AlertBannerProps): React.JSX.Element {
  const resolvedTone = tone ?? 'info'

  return (
    <div role="status" className={cn(alertVariants({ tone: resolvedTone }), className)}>
      <Icon
        name={TONE_ICON[resolvedTone]}
        className={cn('mt-0.5 size-4 shrink-0', TONE_ICON_COLOR[resolvedTone])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="typography-ui-label font-semibold text-(--color-text)">{title}</p>
        {description !== undefined ? (
          <p className="typography-meta text-(--color-text-muted)">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
      {onDismiss !== undefined ? (
        <IconButton
          label="Dismiss notice"
          size="xs"
          onClick={onDismiss}
          icon={<Icon name="close" className="size-3.5" />}
        />
      ) : null}
    </div>
  )
}

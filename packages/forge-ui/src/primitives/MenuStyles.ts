/**
 * Shared floating popup and menu item styles modeled on `@openchamber/ui`.
 */

export const menuPopupClass =
  'forge-glass-popover z-(--z-dialog) min-w-[10rem] max-w-[calc(100vw-16px)] rounded-(--radius-xl) border border-(--color-edge) p-1 text-(--color-text) outline-none transition-[opacity,transform] duration-(--duration-fast) ease-(--ease-out) data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-reduce:transition-none'

export const menuItemClass =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-(--radius-lg) px-2 py-1.5 typography-ui-label text-(--color-text) outline-none data-[highlighted]:bg-(--color-interactive-hover) data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-(--color-danger) data-[variant=destructive]:data-[highlighted]:bg-(--color-danger-muted) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

export const menuSeparatorClass = 'my-1 -mx-1 h-px bg-(--color-edge-muted)'

export const menuLabelClass =
  'px-2 py-1 typography-micro font-semibold tracking-wide text-(--color-text-subtle) uppercase select-none'

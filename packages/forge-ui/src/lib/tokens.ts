/**
 * Typed design system token references matching `packages/forge-ui/src/styles/`.
 *
 * Primitives and tests reference these named scales instead of inventing magic
 * pixel values or ad-hoc CSS variable strings.
 */

export const FORGE_CONTROL_HEIGHTS = {
  xs: 'var(--control-height-xs)',
  sm: 'var(--control-height-sm)',
  md: 'var(--control-height-md)',
  lg: 'var(--control-height-lg)',
} as const

export type ForgeControlSize = keyof typeof FORGE_CONTROL_HEIGHTS

export const FORGE_TYPOGRAPHY_CLASSES = {
  pageTitle: 'typography-page-title',
  uiHeader: 'typography-ui-header',
  uiSection: 'typography-ui-section',
  uiLabel: 'typography-ui-label',
  meta: 'typography-meta',
  micro: 'typography-micro',
  markdown: 'typography-markdown',
  code: 'typography-code',
} as const

export const FORGE_SURFACES = {
  canvas: 'forge-surface-canvas',
  muted: 'forge-surface-muted',
  raised: 'forge-surface-raised',
  floating: 'forge-surface-floating',
  glassPopover: 'forge-glass-popover',
  panelEdge: 'forge-panel-edge',
} as const

export const FORGE_ELEVATION_TOKENS = {
  button: 'var(--elevation-button)',
  raised: 'var(--elevation-raised)',
  floating: 'var(--elevation-floating)',
  ring: 'var(--elevation-ring)',
} as const

export const FORGE_Z_LAYERS = {
  base: 'var(--z-base)',
  sticky: 'var(--z-sticky)',
  drawer: 'var(--z-drawer)',
  dialog: 'var(--z-dialog)',
  tooltip: 'var(--z-tooltip)',
  toast: 'var(--z-toast)',
} as const

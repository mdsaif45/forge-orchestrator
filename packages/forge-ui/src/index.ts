/**
 * Canonical single entry point for Forge's centralized design system (`@forge/ui`).
 *
 * Exports styling token contracts, theme utilities, class-merging helpers, and the
 * unified vector icon system. Interactive compound primitives follow in Phase 1B.
 */

export { cn } from './lib/cn'
export { useTheme, type Theme } from './lib/theme'
export {
  FORGE_CONTROL_HEIGHTS,
  FORGE_ELEVATION_TOKENS,
  FORGE_SURFACES,
  FORGE_TYPOGRAPHY_CLASSES,
  FORGE_Z_LAYERS,
  type ForgeControlSize,
} from './lib/tokens'
export { Icon, type IconProps } from './icons/Icon'
export { FORGE_ICON_REGISTRY, type ForgeIconName } from './icons/registry'

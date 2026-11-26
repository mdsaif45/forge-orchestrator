/**
 * Canonical single entry point for Forge's centralized design system (`@forge/ui`).
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

export { Badge, type BadgeProps } from './primitives/Badge'
export { Button, buttonVariants, type ButtonProps } from './primitives/Button'
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardProps,
} from './primitives/Card'
export { Checkbox, type CheckboxProps } from './primitives/Checkbox'
export { Code, CodeBlock, type CodeBlockProps } from './primitives/Code'
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
} from './primitives/Collapsible'
export { ConfirmDialog, type ConfirmDialogProps } from './primitives/ConfirmDialog'
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  type ContextMenuItemProps,
  type ContextMenuTriggerProps,
} from './primitives/ContextMenu'
export { Dialog, type DialogProps } from './primitives/Dialog'
export { Drawer, type DrawerProps } from './primitives/Drawer'
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type DropdownMenuContentProps,
  type DropdownMenuItemProps,
  type DropdownMenuTriggerProps,
} from './primitives/DropdownMenu'
export { EmptyState, type EmptyStateProps } from './primitives/EmptyState'
export { Field, type FieldProps } from './primitives/Field'
export { IconButton, type IconButtonProps } from './primitives/IconButton'
export { Input, Textarea, type InputProps, type TextareaProps } from './primitives/Input'
export { Label, type LabelProps } from './primitives/Label'
export {
  List,
  ListRow,
  ListSection,
  type ListProps,
  type ListRowProps,
  type ListSectionProps,
} from './primitives/List'
export { AlertBanner, type AlertBannerProps } from './primitives/Notification'
export {
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  SplitPane,
  type PanelHeaderProps,
  type PanelProps,
  type SplitPaneProps,
} from './primitives/Panel'
export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  type PopoverContentProps,
  type PopoverTriggerProps,
} from './primitives/Popover'
export { RadioGroup, type RadioGroupOption, type RadioGroupProps } from './primitives/RadioGroup'
export { ScrollArea, type ScrollAreaProps } from './primitives/ScrollArea'
export { Select, type SelectOption, type SelectProps } from './primitives/Select'
export { Separator, type SeparatorProps } from './primitives/Separator'
export { Spinner, type SpinnerProps } from './primitives/Spinner'
export { StatusDot, type StatusDotProps } from './primitives/StatusDot'
export { Switch, type SwitchProps } from './primitives/Switch'
export { TabPanel, Tabs, type TabItem, type TabPanelProps, type TabsProps } from './primitives/Tabs'
export { ToastProvider, useToast, type ToastMessage, type ToastTone } from './primitives/Toast'
export {
  ActionToolbar,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  type ActionToolbarProps,
  type ToolbarAction,
  type ToolbarButtonProps,
  type ToolbarProps,
} from './primitives/Toolbar'
export { Tooltip, type TooltipProps } from './primitives/Tooltip'

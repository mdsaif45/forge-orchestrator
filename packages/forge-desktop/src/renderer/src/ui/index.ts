/**
 * The desktop UI facade bridging Forge's centralized `@forge/ui` design system
 * with desktop domain widgets (`WorkflowNode`, `QuestionCard`, `DecisionCard`,
 * `FileTree`, `DiffViewer`, `CodeViewer`, `RealTerminal`, etc.).
 */

export {
  ActionToolbar,
  AlertBanner,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  cn,
  Code,
  CodeBlock,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ConfirmDialog,
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
  Dialog,
  Drawer,
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
  EmptyState,
  Field,
  FORGE_CONTROL_HEIGHTS,
  FORGE_ELEVATION_TOKENS,
  FORGE_ICON_REGISTRY,
  FORGE_SURFACES,
  FORGE_TYPOGRAPHY_CLASSES,
  FORGE_Z_LAYERS,
  Icon,
  IconButton,
  Input,
  Label,
  List,
  ListRow,
  ListSection,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  ScrollArea,
  Select,
  Separator,
  Spinner,
  SplitPane,
  StatusDot,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  ToastProvider,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  useTheme,
  useToast,
  type ActionToolbarProps,
  type AlertBannerProps,
  type BadgeProps,
  type ButtonProps,
  type CardProps,
  type CheckboxProps,
  type CodeBlockProps,
  type CollapsibleTriggerProps,
  type ConfirmDialogProps,
  type ContextMenuItemProps,
  type ContextMenuTriggerProps,
  type DialogProps,
  type DrawerProps,
  type DropdownMenuContentProps,
  type DropdownMenuItemProps,
  type DropdownMenuTriggerProps,
  type EmptyStateProps,
  type FieldProps,
  type ForgeControlSize,
  type ForgeIconName,
  type IconButtonProps,
  type IconProps,
  type InputProps,
  type LabelProps,
  type ListProps,
  type ListRowProps,
  type ListSectionProps,
  type PanelHeaderProps,
  type PanelProps,
  type PopoverContentProps,
  type PopoverTriggerProps,
  type RadioGroupOption,
  type RadioGroupProps,
  type ScrollAreaProps,
  type SelectOption,
  type SelectProps,
  type SeparatorProps,
  type SpinnerProps,
  type SplitPaneProps,
  type StatusDotProps,
  type SwitchProps,
  type TabItem,
  type TabPanelProps,
  type TabsProps,
  type TextareaProps,
  type Theme,
  type ToastMessage,
  type ToastTone,
  type ToolbarAction,
  type ToolbarButtonProps,
  type ToolbarProps,
  type TooltipProps,
} from '@forge/ui'

export {
  WorkflowNode,
  type WorkflowNodeProps,
  type WorkflowNodeState,
} from './primitives/WorkflowNode'
export { WorkflowEdge, type WorkflowEdgeProps } from './primitives/WorkflowEdge'
export { QuestionCard, type QuestionCardProps } from './primitives/QuestionCard'
export { DecisionCard, type DecisionCardProps } from './primitives/DecisionCard'
export { FileTree, type FileTreeProps } from './primitives/FileTree'
export { DiffViewer, type DiffViewerProps } from './primitives/DiffViewer'
export { CodeViewer, type CodeViewerProps } from './primitives/CodeViewer'
export { FileIcon, FolderChevron, type FileIconProps } from './primitives/FileIcons'
export { buildFileTree, filterFileTree, type TreeNode } from './primitives/fileTreeModel'
export {
  highlightCode,
  highlightLine,
  detectLanguage,
  parseDiffLines,
  buildSplitDiff,
  type ParsedDiffLine,
  type SplitDiffRow,
  type DiffLineType,
} from './primitives/syntaxHighlighter'
export { ProviderCard, type ProviderCardProps } from './primitives/ProviderCard'
export {
  AddProviderDialog,
  type AddProviderDialogProps,
  type CustomProviderConfig,
} from './primitives/AddProviderDialog'
export {
  StartWorkflowDialog,
  type StartWorkflowDialogProps,
} from './primitives/StartWorkflowDialog'
export {
  CreateTemplateDialog,
  type CreateTemplateDialogProps,
} from './primitives/CreateTemplateDialog'
export {
  CreateAgentDialog,
  type CreateAgentDialogProps,
  type CustomAgentConfig,
} from './primitives/CreateAgentDialog'
export { AgentCard, type AgentCardProps } from './primitives/AgentCard'
export { MarkdownRenderer, type MarkdownRendererProps } from './primitives/MarkdownRenderer'
export {
  AgentTerminal,
  type AgentTerminalProps,
  type TerminalLogEntry,
} from './primitives/AgentTerminal'
export { AnsiRenderer, type AnsiRendererProps, parseAnsi } from './primitives/AnsiRenderer'
export { WorkflowLaunchpad, type WorkflowLaunchpadProps } from './primitives/WorkflowLaunchpad'
export { RealTerminal, type RealTerminalProps } from './primitives/RealTerminal'
export {
  AddMcpServerDialog,
  type AddMcpServerDialogProps,
  type McpServerConfig,
} from './primitives/AddMcpServerDialog'
export {
  AddCliAgentDialog,
  type AddCliAgentDialogProps,
  type CliAgentConfig,
} from './primitives/AddCliAgentDialog'
export { ToolCallTimeline, type ToolCallTimelineProps } from './primitives/ToolCallTimeline'

/**
 * The single import surface for Forge's design system.
 *
 * Pages import from here and nowhere else for these concepts. A page that needs
 * a control this file does not export should add a primitive rather than style a
 * bare element, so the system stays the one place appearance is decided.
 */

export { cn } from './cn'
export { useTheme, type Theme } from './theme'

export { Badge, type BadgeProps } from './primitives/Badge'
export { Button, type ButtonProps } from './primitives/Button'
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
export { Dialog, type DialogProps } from './primitives/Dialog'
export { Drawer, type DrawerProps } from './primitives/Drawer'
export { EmptyState, type EmptyStateProps } from './primitives/EmptyState'
export { Field, type FieldProps } from './primitives/Field'
export { IconButton, type IconButtonProps } from './primitives/IconButton'
export { Input, Textarea, type InputProps, type TextareaProps } from './primitives/Input'
export { ScrollArea, type ScrollAreaProps } from './primitives/ScrollArea'
export { Select, type SelectOption, type SelectProps } from './primitives/Select'
export { Separator, type SeparatorProps } from './primitives/Separator'
export { Spinner, type SpinnerProps } from './primitives/Spinner'
export { StatusDot, type StatusDotProps } from './primitives/StatusDot'
export { TabPanel, Tabs, type TabItem, type TabPanelProps, type TabsProps } from './primitives/Tabs'
export { ToastProvider, useToast, type ToastMessage, type ToastTone } from './primitives/Toast'
export { Tooltip, type TooltipProps } from './primitives/Tooltip'
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
export {
  MarkdownRenderer,
  type MarkdownRendererProps,
} from './primitives/MarkdownRenderer'
export {
  AgentTerminal,
  type AgentTerminalProps,
  type TerminalLogEntry,
} from './primitives/AgentTerminal'
export {
  AnsiRenderer,
  type AnsiRendererProps,
  parseAnsi,
} from './primitives/AnsiRenderer'
export {
  WorkflowLaunchpad,
  type WorkflowLaunchpadProps,
} from './primitives/WorkflowLaunchpad'
export {
  RealTerminal,
  type RealTerminalProps,
} from './primitives/RealTerminal'


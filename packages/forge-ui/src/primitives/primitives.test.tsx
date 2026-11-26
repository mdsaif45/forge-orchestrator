import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ActionToolbar, Toolbar, ToolbarButton, ToolbarDivider } from './Toolbar'
import { Button } from './Button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './Collapsible'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu'
import { Field } from './Field'
import { IconButton } from './IconButton'
import { Input } from './Input'
import { List, ListRow, ListSection } from './List'
import { AlertBanner } from './Notification'
import { Panel, PanelBody, PanelHeader, SplitPane } from './Panel'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import { RadioGroup } from './RadioGroup'
import { Switch } from './Switch'
import { TabPanel, Tabs } from './Tabs'
import { ToastProvider, useToast } from './Toast'
import { Icon } from '../icons/Icon'

function ToastTrigger(): React.JSX.Element {
  const { show } = useToast()
  return (
    <Button
      size="sm"
      onClick={() => {
        show({ title: 'Decision locked', description: 'Axiom A4 recorded', tone: 'success' })
      }}
    >
      Notify
    </Button>
  )
}

describe('@forge/ui primitive suite', () => {
  it('renders Button & IconButton with intent variants, loading, and accessibility labels', () => {
    const { rerender } = render(
      <>
        <Button variant="primary" size="sm">
          Approve
        </Button>
        <IconButton label="Close view" icon={<Icon name="close" />} />
      </>,
    )

    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Close view' })).toHaveAttribute(
      'aria-label',
      'Close view',
    )

    rerender(
      <Button variant="primary" loading>
        Approve
      </Button>,
    )
    const busy = screen.getByRole('button', { name: /Approve/i })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
  })

  it('wires Field, Label, Input, Switch, and RadioGroup interactively', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    const onRadio = vi.fn()

    render(
      <div>
        <Field label="Project Name" required hint="Repository display name">
          {(bind) => <Input {...bind} defaultValue="forge" />}
        </Field>
        <Switch label="Auto-verify" defaultChecked={false} onCheckedChange={onSwitch} />
        <RadioGroup
          aria-label="Execution mode"
          defaultValue="plan"
          onValueChange={onRadio}
          options={[
            { value: 'plan', label: 'Plan first' },
            { value: 'implement', label: 'Direct build' },
          ]}
        />
      </div>,
    )

    expect(screen.getByLabelText(/Project Name/i)).toHaveValue('forge')

    await user.click(screen.getByRole('switch'))
    expect(onSwitch).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('radio', { name: 'Direct build' }))
    expect(onRadio).toHaveBeenCalledWith('implement')
  })

  it('opens DropdownMenu with items and separators via Base UI Menu', async () => {
    const user = userEvent.setup()
    const onNew = vi.fn()

    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">Select project</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>forge-orchestrator</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNew}>+ New project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole('button', { name: 'Select project' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: '+ New project' }))
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('opens ContextMenu on right-click and triggers menu item', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()

    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>Thread message target</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onCopy}>Copy step log</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )

    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Thread message target') })
    await user.click(screen.getByRole('menuitem', { name: 'Copy step log' }))
    expect(onCopy).toHaveBeenCalledTimes(1)
  })

  it('opens Popover and Collapsible sections on user interaction', async () => {
    const user = userEvent.setup()

    render(
      <div>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm">Open details</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p>Branch worktree details</p>
          </PopoverContent>
        </Popover>

        <Collapsible>
          <CollapsibleTrigger>Subagents</CollapsibleTrigger>
          <CollapsibleContent>Alex (Planner) idle</CollapsibleContent>
        </Collapsible>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Open details' }))
    expect(screen.getByText('Branch worktree details')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Subagents' }))
    expect(screen.getByText('Alex (Planner) idle')).toBeVisible()
  })

  it('renders List, Tabs, Toolbar/ActionToolbar, Panel/SplitPane, Toast, and AlertBanner', async () => {
    const user = userEvent.setup()
    const onRow = vi.fn()
    const onTab = vi.fn()
    const onCopy = vi.fn()
    const onOverflow = vi.fn()

    render(
      <ToastProvider>
        <SplitPane
          primary={
            <Panel>
              <PanelHeader
                title="planning.md"
                actions={
                  <ActionToolbar
                    actions={[
                      { id: 'copy', label: 'Copy plan', icon: 'copy', onSelect: onCopy },
                      {
                        id: 'delete',
                        label: 'Discard draft',
                        icon: 'trash',
                        destructive: true,
                        overflowOnly: true,
                        onSelect: onOverflow,
                      },
                    ]}
                  />
                }
              />
              <PanelBody>
                <Toolbar>
                  <ToolbarButton label="Run stage" icon="play" pressed />
                  <ToolbarDivider />
                  <ToastTrigger />
                </Toolbar>
                <Tabs
                  aria-label="Workspace sections"
                  variant="pill"
                  value="overview"
                  onChange={onTab}
                  items={[
                    { value: 'overview', label: 'Overview' },
                    { value: 'diff', label: 'Diffs' },
                  ]}
                />
                <TabPanel active>
                  <List>
                    <ListSection title="Changed Files" count={1}>
                      <ListRow
                        title="Button.tsx"
                        subtitle="packages/forge-ui/src/primitives"
                        onSelect={onRow}
                      />
                    </ListSection>
                  </List>
                </TabPanel>
                <AlertBanner tone="warning" title="Plan approval waiting" />
              </PanelBody>
            </Panel>
          }
          secondary={<div>Right Drawer</div>}
        />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('listitem'))
    expect(onRow).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('tab', { name: 'Diffs' }))
    expect(onTab).toHaveBeenCalledWith('diff')

    await user.click(screen.getByRole('button', { name: 'Copy plan' }))
    expect(onCopy).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Discard draft' }))
    expect(onOverflow).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Notify' }))
    expect(screen.getByText('Decision locked')).toBeVisible()
    expect(screen.getByText('Plan approval waiting')).toBeVisible()
  })

  it('wires ConfirmDialog confirm and cancel callbacks cleanly', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()

    // JSDOM <dialog> needs mock showModal/close methods
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })

    render(
      <ConfirmDialog
        open
        tone="danger"
        title="Delete workspace"
        description="Removes project registration from Forge."
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

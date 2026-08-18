import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Code,
  CodeBlock,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  ScrollArea,
  Select,
  Separator,
  Spinner,
  StatusDot,
  TabPanel,
  Tabs,
  Textarea,
  Tooltip,
  useTheme,
  useToast,
} from '../ui'

/**
 * Renders every primitive in every variant.
 *
 * Its job is to make a regression visible: if a token changes or a variant
 * breaks, it shows here rather than in whichever feature screen happens to use
 * it. Also the fastest way to check both themes.
 */
export function KitchenSink(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const { show } = useToast()
  const [tab, setTab] = useState<'buttons' | 'forms' | 'feedback' | 'overlays'>('buttons')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-(length:--text-2xl) font-semibold">Kitchen sink</h1>
            <p className="text-(length:--text-xs) text-(--color-text-muted)">
              Every primitive, every variant. Current theme: <Code>{theme}</Code>
            </p>
          </div>
          <Button onClick={toggleTheme} variant="secondary">
            Switch to {theme === 'dark' ? 'light' : 'dark'}
          </Button>
        </header>

        <Tabs
          aria-label="Primitive categories"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'buttons', label: 'Buttons' },
            { value: 'forms', label: 'Forms' },
            { value: 'feedback', label: 'Feedback', adornment: <Badge size="sm">6</Badge> },
            { value: 'overlays', label: 'Overlays' },
          ]}
        />

        <TabPanel active={tab === 'buttons'}>
          <Section title="Button variants">
            <Row>
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="danger-subtle">Danger subtle</Button>
            </Row>
          </Section>

          <Section title="Sizes and states">
            <Row>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
              <Button
                loading={loading}
                onClick={() => {
                  setLoading(true)
                  setTimeout(() => setLoading(false), 1200)
                }}
              >
                {loading ? 'Working' : 'Click to load'}
              </Button>
            </Row>
          </Section>

          <Section title="Icon buttons">
            <Row>
              <IconButton label="Refresh" icon={<RefreshIcon />} />
              <IconButton label="Refresh" variant="secondary" icon={<RefreshIcon />} />
              <IconButton label="Delete" variant="danger" icon={<RefreshIcon />} />
              <IconButton label="Small" size="sm" icon={<RefreshIcon />} />
              <IconButton label="Large" size="lg" icon={<RefreshIcon />} />
              <Tooltip content="Tooltips appear on hover and on focus">
                <IconButton label="With tooltip" icon={<RefreshIcon />} />
              </Tooltip>
            </Row>
          </Section>
        </TabPanel>

        <TabPanel active={tab === 'forms'}>
          <Section title="Fields">
            <div className="grid max-w-md gap-4">
              <Field label="Project name" hint="Shown throughout Forge" required>
                {(bind) => <Input placeholder="InTime" {...bind} />}
              </Field>

              <Field label="Repository path" error="Not a git repository">
                {(bind) => <Input defaultValue="D:/Projects/InTime" invalid mono {...bind} />}
              </Field>

              <Field label="Default branch">
                {(bind) => (
                  <Select
                    placeholder="Select a branch"
                    options={[
                      { value: 'main', label: 'main' },
                      { value: 'develop', label: 'develop' },
                      { value: 'legacy', label: 'legacy', disabled: true },
                    ]}
                    {...bind}
                  />
                )}
              </Field>

              <Field label="Project rules" hint="One rule per line">
                {(bind) => (
                  <Textarea
                    mono
                    defaultValue={'do not modify migrations\nfollow existing architecture'}
                    {...bind}
                  />
                )}
              </Field>
            </div>
          </Section>

          <Section title="Input sizes">
            <div className="grid max-w-md gap-2">
              <Input inputSize="sm" placeholder="Small" />
              <Input inputSize="md" placeholder="Medium" />
              <Input inputSize="lg" placeholder="Large" />
              <Input disabled placeholder="Disabled" />
            </div>
          </Section>

          <Section title="Checkboxes">
            <div className="flex flex-col gap-3">
              <Checkbox label="Stop workflow on test failure" defaultChecked />
              <Checkbox label="Stop workflow on open question" hint="Recommended — see axiom A2" />
              <Checkbox label="Allow git push" disabled hint="Requires elevated permissions" />
            </div>
          </Section>
        </TabPanel>

        <TabPanel active={tab === 'feedback'}>
          <Section title="Status dots">
            <Row>
              {(['idle', 'running', 'waiting', 'passed', 'failed', 'halted'] as const).map(
                (status) => (
                  <span key={status} className="inline-flex items-center gap-1.5">
                    <StatusDot status={status} pulse={status === 'running'} label={status} />
                    <span className="text-(length:--text-xs) text-(--color-text-muted)">
                      {status}
                    </span>
                  </span>
                ),
              )}
            </Row>
          </Section>

          <Section title="Badges">
            <Row>
              {(['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const).map(
                (tone) => (
                  <Badge key={tone} tone={tone}>
                    {tone}
                  </Badge>
                ),
              )}
            </Row>
          </Section>

          <Section title="Spinners">
            <Row>
              <Spinner size="sm" />
              <Spinner size="md" />
              <Spinner size="lg" />
            </Row>
          </Section>

          <Section title="Toasts">
            <Row>
              {(['neutral', 'success', 'warning', 'danger'] as const).map((tone) => (
                <Button
                  key={tone}
                  variant="secondary"
                  onClick={() =>
                    show({
                      tone,
                      title: `${tone} notification`,
                      description: 'Feedback on a completed action.',
                    })
                  }
                >
                  Show {tone}
                </Button>
              ))}
            </Row>
          </Section>

          <Section title="Cards">
            <div className="grid gap-3 sm:grid-cols-3">
              {(['default', 'raised', 'inset'] as const).map((tone) => (
                <Card key={tone} tone={tone}>
                  <CardHeader>
                    <div>
                      <CardTitle>{tone}</CardTitle>
                      <CardDescription>Surface tone</CardDescription>
                    </div>
                    <StatusDot status="passed" label="passed" />
                  </CardHeader>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="Empty state">
            <Card padding="none">
              <EmptyState
                title="No workflows yet"
                description="Start a discussion to plan your first change. Forge will orchestrate the agents from there."
                action={<Button variant="primary">Start discussion</Button>}
              />
            </Card>
          </Section>

          <Section title="Code">
            <div className="flex flex-col gap-3">
              <p className="text-(length:--text-sm)">
                Changed <Code>src/main/index.ts</Code> at <Code>4fa1fc5</Code>
              </p>
              <CodeBlock showLineNumbers>
                {'export function createWindow() {\n  return new BrowserWindow({\n    sandbox: true,\n  })\n}'}
              </CodeBlock>
            </div>
          </Section>
        </TabPanel>

        <TabPanel active={tab === 'overlays'}>
          <Section title="Dialog and drawer">
            <Row>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Open dialog
              </Button>
              <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
                Open drawer
              </Button>
            </Row>
          </Section>

          <Section title="Separators">
            <div className="flex flex-col gap-3">
              <Separator />
              <div className="flex h-8 items-center gap-3">
                <span className="text-(length:--text-xs) text-(--color-text-muted)">left</span>
                <Separator orientation="vertical" />
                <span className="text-(length:--text-xs) text-(--color-text-muted)">right</span>
              </div>
            </div>
          </Section>
        </TabPanel>

        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Lock these decisions?"
          description="Locked decisions cannot be changed by an agent without your approval."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Lock and continue
              </Button>
            </>
          }
        >
          <p className="text-(length:--text-sm) text-(--color-text-muted)">
            Three decisions will be locked. Escape closes this dialog, and focus is trapped inside
            it — both from the native <Code>&lt;dialog&gt;</Code> element.
          </p>
        </Dialog>

        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Step output"
          description="planner · 11 files inspected"
          footer={
            <Button variant="secondary" onClick={() => setDrawerOpen(false)}>
              Close
            </Button>
          }
        >
          <CodeBlock>
            {'{\n  "status": "completed",\n  "filesChanged": [],\n  "assumptions": []\n}'}
          </CodeBlock>
        </Drawer>
      </div>
    </ScrollArea>
  )
}

function Section({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3 py-3">
      <h2 className="text-(length:--text-xs) font-semibold tracking-wide text-(--color-text-subtle) uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
      <path d="M13.5 2.5V5H11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

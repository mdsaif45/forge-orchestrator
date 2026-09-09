import React, { useMemo, useState } from 'react'
import type { WorkflowTemplateV2View } from '@shared/ipc'
import { Badge, Button, Card } from '@renderer/ui'

export interface WorkflowCatalogViewProps {
  readonly templates: readonly WorkflowTemplateV2View[]
  readonly onOpenInCanvas: (template: WorkflowTemplateV2View) => void
  readonly onRunWorkflow: (template: WorkflowTemplateV2View) => void
  readonly onCreateNewWorkflow: () => void
  readonly onCloneWorkflow: (template: WorkflowTemplateV2View) => void
  readonly onDeleteWorkflow: (templateId: string) => void
  readonly onTogglePublish: (template: WorkflowTemplateV2View) => void
}

type TabKey = 'all' | 'published' | 'draft' | 'archived'

export function WorkflowCatalogView({
  templates,
  onOpenInCanvas,
  onRunWorkflow,
  onCreateNewWorkflow,
  onCloneWorkflow,
  onDeleteWorkflow,
  onTogglePublish,
}: WorkflowCatalogViewProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)

  const counts = useMemo(() => {
    return {
      all: templates.length,
      published: templates.filter((t) => t.status === 'published').length,
      draft: templates.filter((t) => t.status === 'draft').length,
      archived: templates.filter((t) => t.status === 'archived').length,
    }
  }, [templates])

  const filteredTemplates = useMemo(() => {
    let list = templates
    if (activeTab !== 'all') {
      list = list.filter((t) => t.status === activeTab)
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      )
    }
    return list
  }, [templates, activeTab, searchQuery])

  return (
    <div className="flex h-full flex-col gap-5 p-6 overflow-y-auto">
      {/* 1. Header Bar */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-(--color-text)">Workflows</h1>
          <p className="text-[13px] text-(--color-text-muted)">
            Create, edit, and manage your reusable AI workflows.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={onCreateNewWorkflow}>
          <span className="mr-1 text-[16px] leading-none">+</span> New Workflow
        </Button>
      </div>

      {/* 2. Controls: Filter Tabs & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Tabs */}
        <div className="flex items-center rounded-lg border border-(--color-border) bg-(--color-surface) p-1">
          {(
            [
              { key: 'all', label: 'All', count: counts.all },
              { key: 'published', label: 'Published', count: counts.published },
              { key: 'draft', label: 'Draft', count: counts.draft },
              { key: 'archived', label: 'Archived', count: counts.archived },
            ] as const
          ).map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveTab(tab.key)
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all ${
                  isActive
                    ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs'
                    : 'text-(--color-text-muted) hover:text-(--color-text)'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                    isActive
                      ? 'bg-(--color-accent)/20 text-(--color-accent)'
                      : 'bg-(--color-surface-raised) text-(--color-text-muted)'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative min-w-[240px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
            }}
            placeholder="Search workflows..."
            className="w-full rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-[13px] text-(--color-text) placeholder:text-(--color-text-muted) focus:border-(--color-accent) focus:outline-none"
          />
        </div>
      </div>

      {/* 3. Catalog Grid */}
      {filteredTemplates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-(--color-border) p-12 text-center">
          <div className="mb-2 text-[32px]">🧩</div>
          <h3 className="text-[15px] font-semibold text-(--color-text)">No workflows found</h3>
          <p className="mt-1 text-[13px] text-(--color-text-muted)">
            {searchQuery
              ? `No workflows match "${searchQuery}".`
              : `No workflows in the ${activeTab} category.`}
          </p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={onCreateNewWorkflow}>
            Create your first workflow
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((template) => {
            const isPublished = template.status === 'published'
            const isDraft = template.status === 'draft'
            const isMenuOpen = activeMenuId === template.id

            return (
              <Card
                key={template.id}
                className="group relative flex flex-col justify-between overflow-visible rounded-xl border border-(--color-border) bg-(--color-surface) p-4 transition-all duration-(--duration-fast) hover:border-(--color-border-strong) hover:shadow-md"
              >
                {/* Card Top */}
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={isPublished ? 'success' : isDraft ? 'warning' : 'neutral'}>
                        {template.status.toUpperCase()}
                      </Badge>
                      <Badge tone="neutral">v{template.version}</Badge>
                      <Badge tone="accent">{template.category}</Badge>
                    </div>

                    {/* 3-dots Context Menu */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveMenuId(isMenuOpen ? null : template.id)
                        }}
                        className="rounded p-1 text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)"
                        aria-label="Workflow actions"
                      >
                        ⋮
                      </button>

                      {isMenuOpen && (
                        <div
                          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-(--color-border) bg-(--color-surface-raised) py-1 shadow-lg backdrop-blur-md"
                          onMouseLeave={() => {
                            setActiveMenuId(null)
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null)
                              onOpenInCanvas(template)
                            }}
                            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-(--color-text) hover:bg-(--color-surface)"
                          >
                            ✏️ Edit in Canvas
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null)
                              onCloneWorkflow(template)
                            }}
                            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-(--color-text) hover:bg-(--color-surface)"
                          >
                            📋 Duplicate / Clone
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null)
                              onTogglePublish(template)
                            }}
                            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-(--color-text) hover:bg-(--color-surface)"
                          >
                            {isPublished ? '📦 Switch to Draft' : '🚀 Publish Workflow'}
                          </button>
                          {!['cr-sdlc', 'design-doc'].includes(template.id) && (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveMenuId(null)
                                onDeleteWorkflow(template.id)
                              }}
                              className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-(--color-danger) hover:bg-(--color-danger)/10"
                            >
                              🗑️ Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <h3 className="text-[15px] font-bold text-(--color-text)">{template.name}</h3>
                  <p className="mt-1 line-clamp-2 text-[12px] text-(--color-text-muted)">
                    {template.description}
                  </p>
                </div>

                {/* Card Footer */}
                <div className="mt-4 flex items-center justify-between border-t border-(--color-border)/60 pt-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
                    <span>🧩 {template.nodes.length} nodes</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onOpenInCanvas(template)
                      }}
                      className="text-[12px]"
                    >
                      Canvas
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        onRunWorkflow(template)
                      }}
                      className="text-[12px]"
                    >
                      Run
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

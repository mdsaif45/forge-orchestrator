import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkflowArtifactView,
  WorkflowEdgeView,
  WorkflowNodeView,
  WorkflowTemplateV2View,
} from '@shared/ipc'
import { Badge, Button, useToast } from '@renderer/ui'

export interface WorkflowCanvasProps {
  readonly template: WorkflowTemplateV2View
  readonly onBack: () => void
  readonly onSave: (updatedTemplate: WorkflowTemplateV2View) => void
  readonly onRun: (template: WorkflowTemplateV2View) => void
  readonly activeRunningNodeId?: string | null
  readonly completedNodeIds?: readonly string[]
  readonly failedNodeIds?: readonly string[]
  readonly nodeArtifacts?: ReadonlyMap<string, readonly WorkflowArtifactView[]>
  readonly onSelectArtifact?: (artifact: WorkflowArtifactView) => void
}

interface PaletteItem {
  readonly id: string
  readonly title: string
  readonly type: 'agent' | 'user_gate' | 'verification' | 'router'
  readonly runtimeType: 'forge-native' | 'cli-agent' | 'human' | 'forge-engine'
  readonly defaultAgentExecutable?: string
  readonly icon: string
  readonly description: string
  readonly category: 'Agents' | 'Gates' | 'Verification'
  readonly skills: readonly string[]
  readonly defaultInputs: readonly { name: string; kind: string; required: boolean }[]
  readonly defaultOutputs: readonly {
    name: string
    kind: string
    format: 'markdown' | 'diff' | 'json' | 'text'
    requiredSections: readonly string[]
  }[]
}

const PALETTE_ITEMS: readonly PaletteItem[] = [
  {
    id: 'palette-reqs',
    title: 'Requirements Analyst',
    type: 'agent',
    runtimeType: 'forge-native',
    icon: '📋',
    description: 'Generates structured PRDs and acceptance criteria from raw goals.',
    category: 'Agents',
    skills: ['requirements-analysis', 'prd-writing'],
    defaultInputs: [{ name: 'goal', kind: 'user_prompt', required: true }],
    defaultOutputs: [
      {
        name: 'spec',
        kind: 'final_specification',
        format: 'markdown',
        requiredSections: ['1. Goal', '2. Acceptance Criteria'],
      },
    ],
  },
  {
    id: 'palette-architect',
    title: 'Solution Architect',
    type: 'agent',
    runtimeType: 'forge-native',
    icon: '🏛️',
    description: 'Drafts high-level architecture, module boundaries, and Mermaid diagrams.',
    category: 'Agents',
    skills: ['architecture-design', 'mermaid-diagrams'],
    defaultInputs: [{ name: 'spec', kind: 'final_specification', required: true }],
    defaultOutputs: [
      {
        name: 'architecture',
        kind: 'solution_architecture',
        format: 'markdown',
        requiredSections: ['1. Architecture Overview', '2. Data Flow'],
      },
    ],
  },
  {
    id: 'palette-planner',
    title: 'Implementation Planner',
    type: 'agent',
    runtimeType: 'forge-native',
    icon: '🗺️',
    description: 'Produces a step-by-step file modification blueprint for developers.',
    category: 'Agents',
    skills: ['task-breakdown', 'file-planning'],
    defaultInputs: [{ name: 'architecture', kind: 'solution_architecture', required: true }],
    defaultOutputs: [
      {
        name: 'plan',
        kind: 'implementation_plan',
        format: 'markdown',
        requiredSections: ['Proposed Changes', 'Verification Plan'],
      },
    ],
  },
  {
    id: 'palette-cli-developer',
    title: 'CLI Developer Agent',
    type: 'agent',
    runtimeType: 'cli-agent',
    icon: '⚡',
    description: 'Executes code changes inside git sandbox using an installed system CLI.',
    category: 'Agents',
    skills: ['code-implementation', 'ast-editing'],
    defaultInputs: [{ name: 'plan', kind: 'approved_plan', required: true }],
    defaultOutputs: [
      {
        name: 'diff',
        kind: 'code_diff',
        format: 'diff',
        requiredSections: [],
      },
    ],
  },
  {
    id: 'palette-opencode-agent',
    title: 'OpenCode CLI Agent',
    type: 'agent',
    runtimeType: 'cli-agent',
    defaultAgentExecutable: 'opencode',
    icon: '💻',
    description: 'Executes code changes using installed OpenCode CLI harness.',
    category: 'Agents',
    skills: ['code-implementation'],
    defaultInputs: [{ name: 'plan', kind: 'approved_plan', required: true }],
    defaultOutputs: [
      {
        name: 'diff',
        kind: 'code_diff',
        format: 'diff',
        requiredSections: [],
      },
    ],
  },
  {
    id: 'palette-autonomous-agent',
    title: 'Autonomous CLI Agent',
    type: 'agent',
    runtimeType: 'cli-agent',
    icon: '🚀',
    description: 'Runs autonomous tasks via installed system agent harness.',
    category: 'Agents',
    skills: ['autonomous-coding'],
    defaultInputs: [{ name: 'plan', kind: 'approved_plan', required: true }],
    defaultOutputs: [
      {
        name: 'diff',
        kind: 'code_diff',
        format: 'diff',
        requiredSections: [],
      },
    ],
  },
  {
    id: 'palette-reviewer',
    title: 'Code Reviewer',
    type: 'agent',
    runtimeType: 'forge-native',
    icon: '🔍',
    description: 'Audits patch for security regressions, code style, and test coverage.',
    category: 'Agents',
    skills: ['code-review', 'security-audit'],
    defaultInputs: [
      { name: 'diff', kind: 'code_diff', required: true },
      { name: 'spec', kind: 'final_specification', required: true },
    ],
    defaultOutputs: [
      {
        name: 'review',
        kind: 'review_report',
        format: 'markdown',
        requiredSections: ['1. Summary', '2. Verdict'],
      },
    ],
  },
  {
    id: 'palette-gate',
    title: 'Blueprint Review Gate',
    type: 'user_gate',
    runtimeType: 'human',
    icon: '👤',
    description: 'Human approval gate. Pauses execution until you inspect and approve.',
    category: 'Gates',
    skills: [],
    defaultInputs: [{ name: 'plan', kind: 'implementation_plan', required: true }],
    defaultOutputs: [
      {
        name: 'approved_plan',
        kind: 'approved_plan',
        format: 'markdown',
        requiredSections: [],
      },
    ],
  },
  {
    id: 'palette-verifier',
    title: 'Verification Engine (Build & Test)',
    type: 'verification',
    runtimeType: 'forge-engine',
    icon: '🧪',
    description: 'Axiom A3 automated gate: executes project build and vitest/jest test suite.',
    category: 'Verification',
    skills: [],
    defaultInputs: [{ name: 'diff', kind: 'code_diff', required: true }],
    defaultOutputs: [
      {
        name: 'test_evidence',
        kind: 'verification_results',
        format: 'json',
        requiredSections: [],
      },
    ],
  },
]

export function WorkflowCanvas({
  template,
  onBack,
  onSave,
  onRun,
  activeRunningNodeId,
  completedNodeIds = [],
  failedNodeIds = [],
  nodeArtifacts,
  onSelectArtifact,
}: WorkflowCanvasProps): React.JSX.Element {
  const { show } = useToast()

  // Working template state
  const [currentTemplate, setCurrentTemplate] = useState<WorkflowTemplateV2View>(template)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [connectingSource, setConnectingSource] = useState<{
    nodeId: string
    handle: string
  } | null>(null)

  // Installed CLIs detected on system
  const [installedClis, setInstalledClis] = useState<
    readonly {
      readonly id: string
      readonly name: string
      readonly executable: string
      readonly available: boolean
    }[]
  >([])

  // Canvas pan & zoom state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })

  // Node dragging
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const dragOffsetRef = useRef({ x: 0, y: 0 })

  // Palette search
  const [paletteQuery, setPaletteQuery] = useState('')

  // Load installed CLIs
  useEffect(() => {
    window.forge.runtime
      .detectClis()
      .then((res) => {
        if (res.ok) {
          setInstalledClis(res.value.clis)
        }
      })
      .catch(() => {
        // Fallback silently
      })
  }, [])

  const selectedNode = useMemo(
    () => currentTemplate.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [currentTemplate.nodes, selectedNodeId],
  )

  // Add node from palette
  const handleAddPaletteNode = (item: PaletteItem) => {
    const newId = `node-${crypto.randomUUID().slice(0, 8)}`
    const offset = currentTemplate.nodes.length * 40
    const newNode: WorkflowNodeView = {
      id: newId,
      title: item.title,
      type: item.type,
      runtimeType: item.runtimeType,
      config: {
        agentExecutable: item.defaultAgentExecutable,
        skills: item.skills,
        permissionMode: item.type === 'verification' ? 'read-only' : 'developer',
      },
      inputs: item.defaultInputs,
      outputs: item.defaultOutputs,
      position: {
        x: Math.round(-pan.x + 300 + (offset % 200)),
        y: Math.round(-pan.y + 150 + (offset % 300)),
      },
    }

    setCurrentTemplate((prev) => ({
      ...prev,
      nodes: [...prev.nodes, newNode],
      updatedAt: new Date().toISOString(),
    }))
    setSelectedNodeId(newId)
    show({ title: `Added ${item.title}`, tone: 'neutral' })
  }

  // Node drag handlers
  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    const node = currentTemplate.nodes.find((n) => n.id === nodeId)
    if (!node) return

    setDraggingNodeId(nodeId)
    setSelectedNodeId(nodeId)
    const posX = node.position?.x ?? 0
    const posY = node.position?.y ?? 0
    dragOffsetRef.current = {
      x: e.clientX / zoom - posX,
      y: e.clientY / zoom - posY,
    }
  }

  // Canvas mouse handlers for panning and dragging
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'svg') {
      setIsPanning(true)
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      setSelectedNodeId(null)
      setConnectingSource(null)
    }
  }

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      })
    } else if (draggingNodeId !== null) {
      const newX = Math.round(e.clientX / zoom - dragOffsetRef.current.x)
      const newY = Math.round(e.clientY / zoom - dragOffsetRef.current.y)

      setCurrentTemplate((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === draggingNodeId ? { ...n, position: { x: newX, y: newY } } : n,
        ),
      }))
    }
  }

  const handleCanvasMouseUp = () => {
    setIsPanning(false)
    setDraggingNodeId(null)
  }

  // Connecting slots
  const handleSlotClick = (
    e: React.MouseEvent,
    nodeId: string,
    handle: string,
    isOutput: boolean,
  ) => {
    e.stopPropagation()
    if (isOutput) {
      setConnectingSource({ nodeId, handle })
      show({ title: `Connecting from ${handle}... Click target input slot`, tone: 'neutral' })
    } else if (connectingSource !== null) {
      if (connectingSource.nodeId === nodeId) {
        show({ title: 'Cannot connect a node to itself', tone: 'warning' })
        setConnectingSource(null)
        return
      }

      // Create new edge
      const edgeId = `edge-${crypto.randomUUID().slice(0, 8)}`
      const newEdge: WorkflowEdgeView = {
        id: edgeId,
        source: connectingSource.nodeId,
        sourceHandle: connectingSource.handle,
        target: nodeId,
        targetHandle: handle,
      }

      setCurrentTemplate((prev) => ({
        ...prev,
        edges: [...prev.edges, newEdge],
        updatedAt: new Date().toISOString(),
      }))
      setConnectingSource(null)
      show({ title: 'Connected nodes', tone: 'success' })
    }
  }

  const handleDeleteEdge = (edgeId: string) => {
    setCurrentTemplate((prev) => ({
      ...prev,
      edges: prev.edges.filter((e) => e.id !== edgeId),
      updatedAt: new Date().toISOString(),
    }))
    show({ title: 'Connection removed', tone: 'neutral' })
  }

  const handleDeleteNode = (nodeId: string) => {
    setCurrentTemplate((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== nodeId),
      edges: prev.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      updatedAt: new Date().toISOString(),
    }))
    if (selectedNodeId === nodeId) setSelectedNodeId(null)
    show({ title: 'Node removed', tone: 'neutral' })
  }

  // Update selected node attributes in inspector
  const updateSelectedNode = (patch: Partial<WorkflowNodeView>) => {
    if (selectedNodeId === null) return
    setCurrentTemplate((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === selectedNodeId ? { ...n, ...patch } : n)),
      updatedAt: new Date().toISOString(),
    }))
  }

  // Save template
  const handleSaveClick = () => {
    onSave(currentTemplate)
    show({ title: 'Workflow saved successfully', tone: 'success' })
  }

  // Filtered palette items
  const filteredPalette = useMemo(() => {
    if (!paletteQuery.trim()) return PALETTE_ITEMS
    const q = paletteQuery.toLowerCase()
    return PALETTE_ITEMS.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    )
  }, [paletteQuery])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-surface)">
      {/* 1. TOP HEADER TOOLBAR */}
      <div className="flex h-13 items-center justify-between border-b border-(--color-border) px-4 bg-(--color-surface-raised)">
        {/* Left: Back & Title */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="text-(--color-text-muted)">
            ← Workflows
          </Button>
          <div className="h-4 w-px bg-(--color-border)" />
          <input
            type="text"
            value={currentTemplate.name}
            onChange={(e) => {
              setCurrentTemplate((prev) => ({ ...prev, name: e.target.value }))
            }}
            className="rounded px-1.5 py-0.5 font-bold text-[15px] text-(--color-text) hover:bg-(--color-surface) focus:bg-(--color-surface) focus:outline-none"
          />
          <Badge tone={currentTemplate.status === 'published' ? 'success' : 'warning'}>
            {currentTemplate.status.toUpperCase()}
          </Badge>
          <Badge tone="neutral">v{currentTemplate.version}</Badge>
        </div>

        {/* Center: Zoom Controls */}
        <div className="flex items-center gap-1 rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-0.5 text-[12px]">
          <button
            type="button"
            onClick={() => {
              setZoom((z) => Math.max(0.4, z - 0.1))
            }}
            className="px-1 text-(--color-text-muted) hover:text-(--color-text)"
          >
            -
          </button>
          <span className="w-10 text-center font-mono text-(--color-text)">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => {
              setZoom((z) => Math.min(2, z + 0.1))
            }}
            className="px-1 text-(--color-text-muted) hover:text-(--color-text)"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1)
              setPan({ x: 0, y: 0 })
            }}
            className="ml-1 border-l border-(--color-border) pl-1.5 text-[11px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            Reset
          </button>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const newStatus = currentTemplate.status === 'published' ? 'draft' : 'published'
              setCurrentTemplate((prev) => ({ ...prev, status: newStatus }))
              show({
                title: newStatus === 'published' ? 'Published' : 'Switched to Draft',
                tone: 'neutral',
              })
            }}
          >
            {currentTemplate.status === 'published' ? 'Draft' : 'Publish'}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSaveClick}>
            Save
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onRun(currentTemplate)
            }}
          >
            ▶ Run Workflow
          </Button>
        </div>
      </div>

      {/* 2. MAIN BODY: PALETTE | CANVAS | INSPECTOR */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* LEFT PALETTE (Lego Pieces) */}
        <div className="flex w-64 flex-col border-r border-(--color-border) bg-(--color-surface-raised) p-3">
          <div className="mb-2">
            <h2 className="text-[13px] font-bold text-(--color-text)">Node Palette</h2>
            <p className="text-[11px] text-(--color-text-muted)">
              Click to add modular Lego pieces
            </p>
          </div>

          <input
            type="text"
            value={paletteQuery}
            onChange={(e) => {
              setPaletteQuery(e.target.value)
            }}
            placeholder="Filter components..."
            className="mb-3 rounded border border-(--color-border) bg-(--color-surface) px-2 py-1 text-[12px] text-(--color-text) focus:border-(--color-accent) focus:outline-none"
          />

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {filteredPalette.map((item) => (
              <div
                key={item.id}
                onClick={() => {
                  handleAddPaletteNode(item)
                }}
                className="group flex cursor-pointer flex-col gap-1 rounded-lg border border-(--color-border) bg-(--color-surface) p-2.5 transition-all hover:border-(--color-accent) hover:bg-(--color-surface-raised) hover:shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-(--color-text)">
                    <span>{item.icon}</span>
                    <span>{item.title}</span>
                  </span>
                  <Badge tone={item.type === 'agent' ? 'accent' : 'neutral'} size="sm">
                    {item.runtimeType === 'cli-agent'
                      ? 'CLI'
                      : item.runtimeType === 'forge-native'
                        ? 'Native'
                        : item.type}
                  </Badge>
                </div>
                <p className="text-[11px] text-(--color-text-muted) line-clamp-2">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* CENTER INTERACTIVE CANVAS */}
        <div
          className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
        >
          {/* Connection Lines (SVG) */}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{
              transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)})`,
              transformOrigin: '0 0',
            }}
          >
            {currentTemplate.edges.map((edge) => {
              const sourceNode = currentTemplate.nodes.find((n) => n.id === edge.source)
              const targetNode = currentTemplate.nodes.find((n) => n.id === edge.target)
              if (!sourceNode || !targetNode) return null

              const x1 = (sourceNode.position?.x ?? 0) + 240
              const y1 = (sourceNode.position?.y ?? 0) + 60
              const x2 = targetNode.position?.x ?? 0
              const y2 = (targetNode.position?.y ?? 0) + 60

              const dx = Math.abs(x2 - x1) * 0.5
              const path = `M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 - dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`

              return (
                <g key={edge.id} className="pointer-events-auto group">
                  <path
                    d={path}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="2.5"
                    strokeOpacity="0.7"
                    className="transition-all hover:stroke-width-4 hover:stroke-(--color-danger)"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteEdge(edge.id)
                    }}
                  />
                  {/* Midpoint disconnect button */}
                  <circle
                    cx={(x1 + x2) / 2}
                    cy={(y1 + y2) / 2}
                    r="6"
                    fill="var(--color-surface-raised)"
                    stroke="var(--color-accent)"
                    strokeWidth="1.5"
                    className="cursor-pointer hover:fill-(--color-danger) hover:stroke-(--color-danger)"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteEdge(edge.id)
                    }}
                  />
                </g>
              )
            })}
          </svg>

          {/* Node Cards */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)})`,
              transformOrigin: '0 0',
            }}
          >
            {currentTemplate.nodes.map((node) => {
              const isSelected = selectedNodeId === node.id
              const isRunning = activeRunningNodeId === node.id
              const isCompleted = completedNodeIds.includes(node.id)
              const isFailed = failedNodeIds.includes(node.id)
              const posX = node.position?.x ?? 0
              const posY = node.position?.y ?? 0

              const artifactsForNode = nodeArtifacts?.get(node.id) ?? []

              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => {
                    handleNodeMouseDown(e, node.id)
                  }}
                  style={{
                    transform: `translate(${String(posX)}px, ${String(posY)}px)`,
                    position: 'absolute',
                  }}
                  className={`pointer-events-auto w-[240px] select-none rounded-xl border bg-(--color-surface-raised) p-3 shadow-md transition-shadow ${
                    isSelected
                      ? 'border-(--color-accent) ring-2 ring-(--color-accent)/40 shadow-lg'
                      : isRunning
                        ? 'border-(--color-accent) ring-2 ring-(--color-accent)/70 animate-pulse'
                        : isFailed
                          ? 'border-(--color-danger)'
                          : isCompleted
                            ? 'border-(--color-success)'
                            : 'border-(--color-border) hover:border-(--color-border-strong)'
                  }`}
                >
                  {/* Card Top */}
                  <div className="flex items-center justify-between border-b border-(--color-border)/50 pb-2">
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span className="text-[14px]">
                        {node.type === 'agent' ? '🤖' : node.type === 'user_gate' ? '👤' : '🧪'}
                      </span>
                      <span className="truncate text-[12px] font-bold text-(--color-text)">
                        {node.title}
                      </span>
                    </div>

                    <Badge
                      tone={
                        node.runtimeType === 'cli-agent'
                          ? 'warning'
                          : node.runtimeType === 'forge-native'
                            ? 'accent'
                            : 'neutral'
                      }
                      size="sm"
                    >
                      {node.runtimeType === 'cli-agent'
                        ? (node.config.agentExecutable ?? 'cli')
                        : node.runtimeType === 'forge-native'
                          ? 'native'
                          : node.type}
                    </Badge>
                  </div>

                  {/* Card Body: Input Slots & Output Slots */}
                  <div className="my-2 space-y-2 text-[11px]">
                    {/* Inputs */}
                    <div className="space-y-1">
                      {node.inputs.map((slot) => (
                        <div
                          key={slot.name}
                          onClick={(e) => {
                            handleSlotClick(e, node.id, slot.name, false)
                          }}
                          className="flex items-center gap-1.5 cursor-pointer rounded p-0.5 hover:bg-(--color-surface)"
                        >
                          <span className="h-2 w-2 rounded-full bg-(--color-info)" />
                          <span className="text-(--color-text-muted)">in:</span>
                          <span className="font-mono text-(--color-text)">{slot.name}</span>
                        </div>
                      ))}
                    </div>

                    {/* Outputs */}
                    <div className="space-y-1 border-t border-(--color-border)/30 pt-1">
                      {node.outputs.map((out) => (
                        <div
                          key={out.name}
                          onClick={(e) => {
                            handleSlotClick(e, node.id, out.name, true)
                          }}
                          className="flex items-center justify-between gap-1.5 cursor-pointer rounded p-0.5 hover:bg-(--color-surface)"
                        >
                          <span className="text-(--color-text-muted)">out:</span>
                          <span className="font-mono text-(--color-text)">{out.name}</span>
                          <span className="h-2 w-2 rounded-full bg-(--color-success)" />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Artifacts pills if node completed */}
                  {artifactsForNode.length > 0 && (
                    <div className="mt-2 border-t border-(--color-border)/40 pt-1.5">
                      <div className="flex flex-wrap gap-1">
                        {artifactsForNode.map((art) => (
                          <button
                            key={art.id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onSelectArtifact?.(art)
                            }}
                            className="rounded bg-(--color-accent)/10 px-1.5 py-0.5 text-[10px] font-medium text-(--color-accent) hover:bg-(--color-accent)/20"
                          >
                            📄 {art.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* RIGHT DRAWER: NODE INSPECTOR */}
        {selectedNode && (
          <div className="flex w-80 flex-col border-l border-(--color-border) bg-(--color-surface-raised) p-4 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-(--color-border) pb-3 mb-4">
              <h3 className="text-[14px] font-bold text-(--color-text)">Node Inspector</h3>
              <button
                type="button"
                onClick={() => {
                  setSelectedNodeId(null)
                }}
                className="text-(--color-text-muted) hover:text-(--color-text)"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-[12px]">
              {/* Title */}
              <div>
                <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={selectedNode.title}
                  onChange={(e) => {
                    updateSelectedNode({ title: e.target.value })
                  }}
                  className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                />
              </div>

              {/* Node Type */}
              <div>
                <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                  Node Type
                </label>
                <select
                  value={selectedNode.type}
                  onChange={(e) => {
                    updateSelectedNode({
                      type: e.target.value as WorkflowNodeView['type'],
                    })
                  }}
                  className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                >
                  <option value="agent">Agent (Autonomous reasoning & coding)</option>
                  <option value="user_gate">User Gate (Human review & approval)</option>
                  <option value="verification">Verification (Axiom A3 build & test)</option>
                  <option value="router">Router (Conditional branching)</option>
                </select>
              </div>

              {/* Runtime Type */}
              <div>
                <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                  Runtime Harness
                </label>
                <select
                  value={selectedNode.runtimeType}
                  onChange={(e) => {
                    updateSelectedNode({
                      runtimeType: e.target.value as WorkflowNodeView['runtimeType'],
                    })
                  }}
                  className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                >
                  <option value="forge-native">Forge Agent (Built-in tool loop)</option>
                  <option value="cli-agent">Bring-Your-Own System CLI</option>
                  <option value="human">Human Reviewer</option>
                  <option value="forge-engine">Forge Engine (Tests & builds)</option>
                </select>
              </div>

              {/* CLI Executable if cli-agent */}
              {selectedNode.runtimeType === 'cli-agent' && (
                <div>
                  <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                    CLI Executable
                  </label>
                  <div className="space-y-1">
                    <select
                      value={
                        selectedNode.config.agentExecutable ?? installedClis[0]?.executable ?? ''
                      }
                      onChange={(e) => {
                        updateSelectedNode({
                          config: { ...selectedNode.config, agentExecutable: e.target.value },
                        })
                      }}
                      className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                    >
                      {installedClis.map((cli) => (
                        <option key={cli.id} value={cli.executable}>
                          {cli.name} {cli.available ? '(ready)' : '(not found)'}
                        </option>
                      ))}
                    </select>

                    {/* Show detected status badge */}
                    <div className="flex flex-wrap gap-1 pt-1">
                      {installedClis.map((cli) => (
                        <span
                          key={cli.id}
                          className={`rounded px-1 py-0.2 text-[10px] ${
                            cli.available
                              ? 'bg-(--color-success)/15 text-(--color-success)'
                              : 'bg-(--color-surface) text-(--color-text-muted)'
                          }`}
                        >
                          {cli.executable}: {cli.available ? '✓ ready' : 'not found'}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* System Prompt */}
              <div>
                <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                  System Prompt & Instructions
                </label>
                <textarea
                  rows={4}
                  value={selectedNode.config.systemPrompt ?? ''}
                  onChange={(e) => {
                    updateSelectedNode({
                      config: { ...selectedNode.config, systemPrompt: e.target.value },
                    })
                  }}
                  placeholder="Specific role instructions, guidelines, and constraints..."
                  className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                />
              </div>

              {/* Skills */}
              <div>
                <label className="block text-[11px] font-medium text-(--color-text-muted) mb-1">
                  Injected Skillsets (comma separated)
                </label>
                <input
                  type="text"
                  value={selectedNode.config.skills.join(', ')}
                  onChange={(e) => {
                    const skills = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    updateSelectedNode({
                      config: { ...selectedNode.config, skills },
                    })
                  }}
                  placeholder="e.g. code-implementation, ast-editing, requirements"
                  className="w-full rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-(--color-text) focus:border-(--color-accent) focus:outline-none"
                />
              </div>

              {/* Input Slots */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-(--color-text-muted)">
                    Input Slots
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      updateSelectedNode({
                        inputs: [
                          ...selectedNode.inputs,
                          {
                            name: `input_${String(selectedNode.inputs.length + 1)}`,
                            kind: 'context',
                            required: true,
                          },
                        ],
                      })
                    }}
                    className="text-[11px] text-(--color-accent) hover:underline"
                  >
                    + Add Slot
                  </button>
                </div>
                <div className="space-y-1">
                  {selectedNode.inputs.map((slot, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-1 rounded bg-(--color-surface) p-1.5"
                    >
                      <input
                        type="text"
                        value={slot.name}
                        onChange={(e) => {
                          const updated = [...selectedNode.inputs]
                          updated[idx] = { ...slot, name: e.target.value }
                          updateSelectedNode({ inputs: updated })
                        }}
                        className="w-24 rounded border border-(--color-border) px-1.5 py-0.5 text-[11px]"
                      />
                      <input
                        type="text"
                        value={slot.kind}
                        onChange={(e) => {
                          const updated = [...selectedNode.inputs]
                          updated[idx] = { ...slot, kind: e.target.value }
                          updateSelectedNode({ inputs: updated })
                        }}
                        placeholder="kind"
                        className="w-24 rounded border border-(--color-border) px-1.5 py-0.5 text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          updateSelectedNode({
                            inputs: selectedNode.inputs.filter((_, i) => i !== idx),
                          })
                        }}
                        className="text-(--color-danger) hover:opacity-80 px-1"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Output Slots */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-(--color-text-muted)">
                    Output Deliverables
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      updateSelectedNode({
                        outputs: [
                          ...selectedNode.outputs,
                          {
                            name: `output_${String(selectedNode.outputs.length + 1)}`,
                            kind: 'deliverable',
                            format: 'markdown',
                            requiredSections: [],
                          },
                        ],
                      })
                    }}
                    className="text-[11px] text-(--color-accent) hover:underline"
                  >
                    + Add Output
                  </button>
                </div>
                <div className="space-y-1">
                  {selectedNode.outputs.map((out, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-1 rounded bg-(--color-surface) p-1.5"
                    >
                      <input
                        type="text"
                        value={out.name}
                        onChange={(e) => {
                          const updated = [...selectedNode.outputs]
                          updated[idx] = { ...out, name: e.target.value }
                          updateSelectedNode({ outputs: updated })
                        }}
                        className="w-20 rounded border border-(--color-border) px-1.5 py-0.5 text-[11px]"
                      />
                      <input
                        type="text"
                        value={out.kind}
                        onChange={(e) => {
                          const updated = [...selectedNode.outputs]
                          updated[idx] = { ...out, kind: e.target.value }
                          updateSelectedNode({ outputs: updated })
                        }}
                        placeholder="kind"
                        className="w-20 rounded border border-(--color-border) px-1.5 py-0.5 text-[11px]"
                      />
                      <select
                        value={out.format}
                        onChange={(e) => {
                          const updated = [...selectedNode.outputs]
                          updated[idx] = {
                            ...out,
                            format: e.target.value as 'markdown' | 'diff' | 'json' | 'text',
                          }
                          updateSelectedNode({ outputs: updated })
                        }}
                        className="rounded border border-(--color-border) px-1 py-0.5 text-[10px]"
                      >
                        <option value="markdown">md</option>
                        <option value="diff">diff</option>
                        <option value="json">json</option>
                        <option value="text">text</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          updateSelectedNode({
                            outputs: selectedNode.outputs.filter((_, i) => i !== idx),
                          })
                        }}
                        className="text-(--color-danger) hover:opacity-80 px-1"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Danger Zone: Delete Node */}
              <div className="pt-4 border-t border-(--color-border)">
                <Button
                  variant="danger-subtle"
                  size="sm"
                  className="w-full text-(--color-danger) hover:bg-(--color-danger)/10"
                  onClick={() => {
                    handleDeleteNode(selectedNode.id)
                  }}
                >
                  🗑️ Delete Node
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

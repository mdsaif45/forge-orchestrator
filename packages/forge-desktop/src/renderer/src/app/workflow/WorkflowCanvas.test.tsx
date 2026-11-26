import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { workflowTemplateV2Schema } from '@shared/domain'
import type { WorkflowTemplateV2View } from '@shared/ipc'
import { ToastProvider } from '@renderer/ui'
import { WorkflowCanvas } from './WorkflowCanvas'
import { serializeCanvasToWorkflowSchema, wouldEdgeCreateCycle } from './workflowCanvasModel'

function makeInitialTemplate(): WorkflowTemplateV2View {
  return {
    id: 'wf-canvas-test',
    name: 'Visual Canvas Test Flow',
    description: 'Editable DAG canvas verification',
    version: 1,
    status: 'draft',
    category: 'Engineering',
    nodes: [
      {
        id: 'node-plan',
        title: 'Plan Architecture',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          skills: ['architecture'],
          permissionMode: 'read-only',
        },
        inputs: [{ name: 'goal', kind: 'prompt', required: true }],
        outputs: [{ name: 'plan', kind: 'markdown', format: 'markdown', requiredSections: [] }],
        position: { x: 100, y: 120 },
      },
      {
        id: 'node-gate',
        title: 'Human Review',
        type: 'user_gate',
        runtimeType: 'human',
        config: {
          skills: [],
          permissionMode: 'read-only',
        },
        inputs: [{ name: 'plan', kind: 'markdown', required: true }],
        outputs: [{ name: 'approved', kind: 'decision', format: 'json', requiredSections: [] }],
        position: { x: 420, y: 120 },
      },
    ],
    edges: [],
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  }
}

describe('WorkflowCanvas (UI-001)', () => {
  it('renders agent, gate, verification, and router primitives and supports drag-and-drop onto canvas', () => {
    // Mock preload CLI detection so useEffect resolves cleanly
    Object.defineProperty(window, 'forge', {
      value: {
        runtime: {
          detectClis: vi.fn().mockResolvedValue({ ok: true, value: { clis: [] } }),
        },
      },
      configurable: true,
    })

    const onSave = vi.fn()
    render(
      <ToastProvider>
        <WorkflowCanvas
          template={makeInitialTemplate()}
          onBack={vi.fn()}
          onSave={onSave}
          onRun={vi.fn()}
        />
      </ToastProvider>,
    )

    expect(screen.getByText('Solution Architect')).toBeInTheDocument()
    expect(screen.getByText('Blueprint Review Gate')).toBeInTheDocument()
    expect(screen.getByText('Verification Engine (Build & Test)')).toBeInTheDocument()
    expect(screen.getByText('Conditional Router')).toBeInTheDocument()

    // Drag-and-drop Conditional Router onto the canvas dropzone
    const routerCard = screen.getByText('Conditional Router').closest('[draggable="true"]')
    const dropzone = screen.getByTestId('workflow-canvas-dropzone')
    expect(routerCard).not.toBeNull()

    const payload = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, val: string) => {
        payload.set(type, val)
      },
      getData: (type: string) => payload.get(type) ?? '',
      effectAllowed: 'copy',
    }

    if (routerCard) {
      fireEvent.dragStart(routerCard, { dataTransfer })
      fireEvent.dragOver(dropzone)
      fireEvent.drop(dropzone, { dataTransfer, clientX: 600, clientY: 250 })
    }

    // New Conditional Router node card rendered on canvas alongside inspector
    expect(screen.getAllByText('Conditional Router').length).toBeGreaterThanOrEqual(2)
  })

  it('prevents DAG cycles during reactive edge connections and serializes valid WorkflowTemplateV2 schema', async () => {
    const user = userEvent.setup()
    const exportedJson: string[] = []
    let savedTemplate: WorkflowTemplateV2View | null = null

    render(
      <ToastProvider>
        <WorkflowCanvas
          template={makeInitialTemplate()}
          onBack={vi.fn()}
          onSave={(tmpl) => {
            savedTemplate = tmpl
          }}
          onRun={vi.fn()}
          onExportSchema={(json) => {
            exportedJson.push(json)
          }}
        />
      </ToastProvider>,
    )

    // Connect node-plan out:plan -> node-gate in:plan
    const outputSlots = screen.getAllByText('out:')
    const inputSlots = screen.getAllByText('in:')
    const planOut = outputSlots[0]?.parentElement
    const gateIn = inputSlots[1]?.parentElement
    expect(planOut).toBeDefined()
    expect(gateIn).toBeDefined()

    if (planOut && gateIn) {
      await user.click(planOut)
      await user.click(gateIn)
    }

    // Attempt reverse cycle connection node-gate out:approved -> node-plan in:goal (should be blocked!)
    const gateOut = outputSlots[1]?.parentElement
    const planIn = inputSlots[0]?.parentElement
    if (gateOut && planIn) {
      await user.click(gateOut)
      await user.click(planIn)
    }

    expect(
      screen.getByText('Cycle prevented: connection would create a loop in the workflow DAG'),
    ).toBeInTheDocument()

    // Save & serialize verify only 1 valid acyclic edge exists and validates against WorkflowTemplateV2 schema
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(screen.getByRole('button', { name: 'Export Schema' }))

    expect(savedTemplate).not.toBeNull()
    expect(exportedJson).toHaveLength(1)

    const parsedSchema = workflowTemplateV2Schema.parse(JSON.parse(exportedJson[0] ?? '{}'))
    expect(parsedSchema.nodes).toHaveLength(2)
    expect(parsedSchema.edges).toHaveLength(1)
    expect(parsedSchema.edges[0]?.source).toBe('node-plan')
    expect(parsedSchema.edges[0]?.target).toBe('node-gate')

    // Direct unit check on pure cycle helper and serializer
    expect(wouldEdgeCreateCycle(parsedSchema.edges, 'node-gate', 'node-plan')).toBe(true)
    const report = serializeCanvasToWorkflowSchema(makeInitialTemplate())
    expect(report.valid).toBe(true)
    expect(report.topologicalOrder).toEqual(['node-plan', 'node-gate'])
  })
})

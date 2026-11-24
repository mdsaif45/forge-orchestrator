import { describe, expect, it } from 'vitest'
import {
  extractWorkflowSubgraph,
  isolateCyclePath,
  type GenericWorkflowGraphInput,
} from './subgraphExtractor'

describe('subgraphExtractor (WORK-021)', () => {
  const sampleGraph: GenericWorkflowGraphInput = {
    id: 'test-graph',
    nodes: [
      { id: 'plan', role: 'architect' },
      { id: 'spec', role: 'designer' },
      { id: 'implement', role: 'engineer' },
      { id: 'verify', role: 'qa' },
      { id: 'deploy', role: 'devops' },
      { id: 'standalone', role: 'auditor' },
    ],
    edges: [
      { source: 'plan', target: 'spec' },
      { source: 'spec', target: 'implement' },
      { source: 'implement', target: 'verify' },
      { source: 'verify', target: 'deploy' },
    ],
  }

  it('extracts upstream dependency neighborhood for a target node', () => {
    const report = extractWorkflowSubgraph(sampleGraph, 'implement', { direction: 'upstream' })

    expect(report.valid).toBe(true)
    expect(report.targetNodeId).toBe('implement')
    expect(report.direction).toBe('upstream')
    expect(report.hasCycle).toBe(false)
    expect(report.nodes.map((n) => n.id)).toEqual(['plan', 'spec', 'implement'])
    expect(report.edges).toHaveLength(2)
    expect(report.asciiDiagram).toContain('=== WORKFLOW SUBGRAPH: implement (UPSTREAM) ===')
    expect(report.asciiDiagram).toContain('[implement] [TARGET]')
  })

  it('extracts downstream successor neighborhood for a target node', () => {
    const report = extractWorkflowSubgraph(sampleGraph, 'implement', { direction: 'downstream' })

    expect(report.valid).toBe(true)
    expect(report.nodes.map((n) => n.id)).toEqual(['implement', 'verify', 'deploy'])
    expect(report.edges).toHaveLength(2)
  })

  it('extracts full bidirectional neighborhood', () => {
    const report = extractWorkflowSubgraph(sampleGraph, 'implement', { direction: 'both' })

    expect(report.valid).toBe(true)
    expect(report.nodes).toHaveLength(5)
    expect(report.nodes.some((n) => n.id === 'standalone')).toBe(false)
  })

  it('isolates exact cycle sequence in cyclic graph topologies', () => {
    const cyclicGraph: GenericWorkflowGraphInput = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'D' },
        { source: 'D', target: 'B' }, // cycle B -> C -> D -> B
      ],
    }

    const cycleAudit = isolateCyclePath(cyclicGraph.nodes, cyclicGraph.edges)
    expect(cycleAudit.hasCycle).toBe(true)
    expect(cycleAudit.cyclePath).toEqual(['B', 'C', 'D', 'B'])
    expect(cycleAudit.formattedSummary).toContain('B -> C -> D -> B')

    const report = extractWorkflowSubgraph(cyclicGraph, 'C', { direction: 'both' })
    expect(report.hasCycle).toBe(true)
    expect(report.cyclePath).toEqual(['B', 'C', 'D', 'B'])
    expect(report.asciiDiagram).toContain('[!] Cycle sequence: B -> C -> D -> B')
  })

  it('fails closed when target node is not found in graph', () => {
    const report = extractWorkflowSubgraph(sampleGraph, 'non-existent-node')
    expect(report.valid).toBe(false)
    expect(report.error).toContain('not found in graph')
  })
})

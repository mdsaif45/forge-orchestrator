import { describe, expect, it } from 'vitest'
import {
  WorkflowSpeculativeBranchPruner,
  type SpeculativeBranchNode,
} from './workflowSpeculativeBranchPruner'

describe('WorkflowSpeculativeBranchPruner (WORK-039)', () => {
  it('traverses downstream subtree and prunes speculative descendant nodes recursively', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner({
      defaultWorkflowId: 'wf-speculative-1',
    })

    const nodes: SpeculativeBranchNode[] = [
      {
        id: 'node-root',
        branchId: 'branch-spec-a',
        dependencies: [],
        state: 'FAILED',
        isSpeculative: true,
        estimatedMemoryBytes: 2048,
      },
      {
        id: 'node-child-1',
        branchId: 'branch-spec-a',
        dependencies: ['node-root'],
        state: 'PENDING',
        isSpeculative: true,
        estimatedMemoryBytes: 4096,
      },
      {
        id: 'node-child-2',
        branchId: 'branch-spec-a',
        dependencies: ['node-child-1'],
        state: 'PENDING',
        isSpeculative: true,
        estimatedMemoryBytes: 1024,
      },
      {
        id: 'node-independent',
        branchId: 'branch-primary',
        dependencies: [],
        state: 'COMPLETED',
        isSpeculative: false,
      },
    ]

    pruner.registerNodes(nodes)

    const report = await pruner.pruneSubtree('node-root', 'BRANCH_FAILED')

    expect(report.status).toBe('SUCCESS')
    expect(report.prunedNodeIds).toHaveLength(3)
    expect(report.prunedNodeIds).toContain('node-root')
    expect(report.prunedNodeIds).toContain('node-child-1')
    expect(report.prunedNodeIds).toContain('node-child-2')
    expect(report.prunedNodeIds).not.toContain('node-independent')
    expect(report.reclaimedMemoryBytes).toBe(7168)

    expect(pruner.getNode('node-root')!.state).toBe('PRUNED')
    expect(pruner.getNode('node-child-1')!.state).toBe('PRUNED')
    expect(pruner.getNode('node-child-2')!.state).toBe('PRUNED')
    expect(pruner.getNode('node-independent')!.state).toBe('COMPLETED')
  })

  it('strictly preserves non-speculative primary lineage nodes during downstream traversal', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    const nodes: SpeculativeBranchNode[] = [
      {
        id: 'spec-parent',
        branchId: 'branch-spec',
        dependencies: [],
        state: 'FAILED',
        isSpeculative: true,
      },
      {
        id: 'primary-downstream',
        branchId: 'branch-main',
        dependencies: ['spec-parent'],
        state: 'PENDING',
        isSpeculative: false, // Critical: primary lineage
      },
      {
        id: 'spec-grandchild',
        branchId: 'branch-spec',
        dependencies: ['primary-downstream'],
        state: 'PENDING',
        isSpeculative: true,
      },
    ]

    pruner.registerNodes(nodes)

    const report = await pruner.pruneSubtree('spec-parent', 'BRANCH_FAILED')

    expect(report.prunedNodeIds).toContain('spec-parent')
    expect(report.prunedNodeIds).toContain('spec-grandchild')
    expect(report.preservedNodeIds).toContain('primary-downstream')
    expect(pruner.getNode('primary-downstream')!.state).toBe('PENDING')
  })

  it('cooperatively aborts active running tasks via AbortController and marks ABORT_IN_FLIGHT', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    const rootNode: SpeculativeBranchNode = {
      id: 'active-root',
      branchId: 'branch-active',
      dependencies: [],
      state: 'RUNNING',
      isSpeculative: true,
    }

    pruner.registerNode(rootNode)

    const controller = pruner.createAbortController('active-root')
    expect(controller.signal.aborted).toBe(false)

    const report = await pruner.pruneBranch('branch-active', 'BUDGET_EXCEEDED')

    expect(report.status).toBe('SUCCESS')
    expect(report.activeLeavesAborted).toContain('active-root')
    expect(controller.signal.aborted).toBe(true)

    const decision = report.decisions.find((d) => d.nodeId === 'active-root')
    expect(decision).toBeDefined()
    expect(decision!.action).toBe('ABORT_IN_FLIGHT')
    expect(decision!.reason).toBe('BUDGET_EXCEEDED')
    expect(pruner.getNode('active-root')!.state).toBe('PRUNED')
  })

  it('reclaims ephemeral artifacts and releases resource leases', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    const node: SpeculativeBranchNode = {
      id: 'resource-node',
      branchId: 'branch-res',
      dependencies: [],
      state: 'PENDING',
      isSpeculative: true,
      ephemeralArtifacts: ['tmp/sandbox-1.tar.gz', 'tmp/build-cache.json'],
      resourceLeases: ['lease:gpu-0', 'lease:port-8080'],
      estimatedMemoryBytes: 32768,
    }

    pruner.registerNode(node)

    let reclaimerCalled = false
    pruner.bindResourceReclaimer('resource-node', () => {
      reclaimerCalled = true
    })

    const report = await pruner.pruneBranch('branch-res', 'MANUAL_ABORT')

    expect(report.status).toBe('SUCCESS')
    expect(reclaimerCalled).toBe(true)
    expect(report.reclaimedArtifacts).toEqual(['tmp/sandbox-1.tar.gz', 'tmp/build-cache.json'])
    expect(report.releasedLeases).toEqual(['lease:gpu-0', 'lease:port-8080'])
    expect(report.reclaimedMemoryBytes).toBe(32768)
  })

  it('handles superseded branch pruning when a competing branch wins', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    pruner.registerNodes([
      {
        id: 'winning-node',
        branchId: 'branch-winner',
        dependencies: [],
        state: 'COMPLETED',
        isSpeculative: true,
      },
      {
        id: 'superseded-node-1',
        branchId: 'branch-loser',
        dependencies: [],
        state: 'RUNNING',
        isSpeculative: true,
      },
      {
        id: 'superseded-node-2',
        branchId: 'branch-loser',
        dependencies: ['superseded-node-1'],
        state: 'PENDING',
        isSpeculative: true,
      },
    ])

    const report = await pruner.pruneBranch('branch-loser', 'BRANCH_SUPERSEDED')

    expect(report.status).toBe('SUCCESS')
    expect(report.reason).toBe('BRANCH_SUPERSEDED')
    expect(pruner.getNode('superseded-node-1')!.state).toBe('SUPERSEDED')
    expect(pruner.getNode('superseded-node-2')!.state).toBe('SUPERSEDED')
    expect(pruner.getNode('winning-node')!.state).toBe('COMPLETED')
  })

  it('handles reclaimer failures gracefully with PARTIAL status', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    pruner.registerNode({
      id: 'faulty-node',
      branchId: 'branch-faulty',
      dependencies: [],
      state: 'PENDING',
      isSpeculative: true,
    })

    pruner.bindResourceReclaimer('faulty-node', () => {
      throw new Error('Disk unmount failed')
    })

    const report = await pruner.pruneBranch('branch-faulty', 'BRANCH_FAILED')

    expect(report.status).toBe('PARTIAL')
    expect(report.prunedNodeIds).toContain('faulty-node')
    expect(pruner.getNode('faulty-node')!.state).toBe('PRUNED')
  })

  it('returns NO_OP when target branch or node is empty or non-existent', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    const branchReport = await pruner.pruneBranch('non-existent-branch')
    expect(branchReport.status).toBe('NO_OP')
    expect(branchReport.prunedNodeIds).toHaveLength(0)

    const nodeReport = await pruner.pruneSubtree('non-existent-node')
    expect(nodeReport.status).toBe('NO_OP')
    expect(nodeReport.prunedNodeIds).toHaveLength(0)
  })

  it('skips redundant eviction when nodes are already PRUNED or SUPERSEDED', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    pruner.registerNode({
      id: 'pruned-node',
      branchId: 'branch-p',
      dependencies: [],
      state: 'PRUNED',
      isSpeculative: true,
    })

    const report = await pruner.pruneBranch('branch-p')
    expect(report.status).toBe('NO_OP')
    expect(report.preservedNodeIds).toContain('pruned-node')
  })

  it('resets all internal state and retains eviction history in getEvictionHistory()', async () => {
    const pruner = new WorkflowSpeculativeBranchPruner()

    pruner.registerNode({
      id: 'node-1',
      branchId: 'branch-1',
      dependencies: [],
      state: 'PENDING',
      isSpeculative: true,
    })

    await pruner.pruneBranch('branch-1')
    expect(pruner.getEvictionHistory()).toHaveLength(1)
    expect(pruner.getPrunedNodes()).toHaveLength(1)

    pruner.reset()
    expect(pruner.getEvictionHistory()).toHaveLength(0)
    expect(pruner.getPrunedNodes()).toHaveLength(0)
    expect(pruner.getNode('node-1')).toBeUndefined()
  })
})

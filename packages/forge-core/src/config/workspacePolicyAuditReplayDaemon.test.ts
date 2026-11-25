import { describe, expect, it, vi } from 'vitest'
import {
  PolicyReplaySpecError,
  WorkspacePolicyAuditReplayDaemon,
  type AttestationViolation,
  type HistoricalAuditEvent,
  type PolicyReplaySpec,
} from './workspacePolicyAuditReplayDaemon'

const BASE_PERMISSIVE_SPEC: PolicyReplaySpec = {
  specId: 'ws-policy-spec',
  policyRevision: 'rev-1.0',
  workspaceRoot: '/workspace/forge',
  toolSandboxPolicy: {
    defaultAction: 'allow',
  },
  enforceWorkspaceBoundary: false,
  batchSize: 2,
}

const STRICT_SANDBOX_SPEC: PolicyReplaySpec = {
  specId: 'ws-policy-spec',
  policyRevision: 'rev-2.0',
  workspaceRoot: '/workspace/forge',
  toolSandboxPolicy: {
    defaultAction: 'block',
    allowedBinaries: ['git', 'npm', 'vitest'],
    rules: [
      {
        binary: 'git',
        allowedSubcommands: ['status', 'diff', 'log'],
        prohibitedFlags: ['--no-verify', '--force'],
      },
    ],
  },
  blockedNetworkHosts: ['evil.example.com', '*.untrusted.io'],
  restrictedSecretKeys: ['PROD_DEPLOY_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
  enforceWorkspaceBoundary: true,
  batchSize: 2,
}

const SAMPLE_EVENTS: readonly HistoricalAuditEvent[] = [
  {
    eventId: 'ev-1',
    timestamp: 1000,
    actorId: 'agent-1',
    actionKind: 'TOOL_EXEC',
    binary: 'git',
    args: ['status'],
    originalDecision: 'ALLOWED',
    policyRevision: 'rev-1.0',
  },
  {
    eventId: 'ev-2',
    timestamp: 2000,
    actorId: 'agent-2',
    actionKind: 'TOOL_EXEC',
    binary: 'curl',
    args: ['https://attacker.org'],
    originalDecision: 'ALLOWED',
    policyRevision: 'rev-1.0',
  },
  {
    eventId: 'ev-3',
    timestamp: 3000,
    actorId: 'agent-2',
    actionKind: 'FILE_ACCESS',
    targetPath: '../outside-secrets/.env',
    originalDecision: 'ALLOWED',
    policyRevision: 'rev-1.0',
  },
  {
    eventId: 'ev-4',
    timestamp: 4000,
    actorId: 'agent-3',
    actionKind: 'NETWORK_EGRESS',
    networkHost: 'api.untrusted.io:443',
    originalDecision: 'ALLOWED',
    policyRevision: 'rev-1.0',
  },
  {
    eventId: 'ev-5',
    timestamp: 5000,
    actorId: 'agent-4',
    actionKind: 'CREDENTIAL_READ',
    secretKey: 'prod_deploy_token',
    originalDecision: 'ALLOWED',
    policyRevision: 'rev-1.0',
  },
]

describe('WorkspacePolicyAuditReplayDaemon (CONFIG-031)', () => {
  it('processes historical events in bounded batches and verifies initial conformance', () => {
    const daemon = new WorkspacePolicyAuditReplayDaemon({ initialSpec: BASE_PERMISSIVE_SPEC })
    daemon.ingestEvents(SAMPLE_EVENTS)

    const initialStatus = daemon.getStatusReport()
    expect(initialStatus.state).toBe('IDLE')
    expect(initialStatus.pendingEventsCount).toBe(5)

    // Batch 1 (2 events)
    const batch1 = daemon.replayNextBatch('run-perm')
    expect(batch1.eventsProcessed).toBe(2)
    expect(batch1.compliantCount).toBe(2)
    expect(batch1.violationsCount).toBe(0)

    // Summary over remaining 3 events (2 batches: 2 + 1)
    const summary = daemon.replayAll({ replayRunId: 'run-perm' })
    expect(summary.batchesProcessed).toBe(2)
    expect(summary.totalEventsReplayed).toBe(3)
    expect(summary.overallStatus).toBe('CONFORMANT')
    expect(summary.complianceRatePercent).toBe(100)
    expect(summary.attestationDigest).toHaveLength(64)
  })

  it('re-attests full event history upon dynamic policy tightening and emits real-time alerts', () => {
    const daemon = new WorkspacePolicyAuditReplayDaemon({ initialSpec: BASE_PERMISSIVE_SPEC })
    daemon.ingestEvents(SAMPLE_EVENTS)

    // Initial full replay under permissive policy moves cursor to end (5)
    const cleanSummary = daemon.replayAll()
    expect(cleanSummary.violationsDetectedCount).toBe(0)
    expect(daemon.getStatusReport().cursorEventIndex).toBe(5)

    const alerts: AttestationViolation[] = []
    const unsubscribe = daemon.onViolationAlert((v) => alerts.push(v))

    // Tighten policy dynamically -> resets cursor to 0
    daemon.updatePolicySpec(STRICT_SANDBOX_SPEC)
    expect(daemon.getStatusReport().cursorEventIndex).toBe(0)
    expect(daemon.getSpecHistory()).toHaveLength(2)

    const summary = daemon.replayAll({ replayRunId: 'strict-recheck' })
    expect(summary.totalEventsReplayed).toBe(5)
    expect(summary.batchesProcessed).toBe(3) // 2 + 2 + 1
    expect(summary.compliantEventsCount).toBe(1) // ev-1 git status only
    expect(summary.violationsDetectedCount).toBe(4) // ev-2, ev-3, ev-4, ev-5
    expect(summary.newlyBlockedRegressionsCount).toBe(4)
    expect(summary.complianceRatePercent).toBe(20)
    expect(summary.overallStatus).toBe('VIOLATIONS_DETECTED')
    expect(summary.criticalViolationsCount).toBe(3) // forbidden_binary + traversal_escape + restricted secret

    expect(alerts).toHaveLength(4)
    expect(alerts.map((a) => a.ruleCategory)).toEqual([
      'TOOL_SANDBOX',
      'WORKSPACE_BOUNDARY',
      'NETWORK_EGRESS',
      'CREDENTIAL_ACCESS',
    ])

    // Unsubscribing prevents further listener delivery
    unsubscribe()
    daemon.replayAll({ fromStart: true })
    expect(alerts).toHaveLength(4)
  })

  it('detects relaxed policy decisions when previously blocked events become allowed', () => {
    const daemon = new WorkspacePolicyAuditReplayDaemon({ initialSpec: BASE_PERMISSIVE_SPEC })
    daemon.ingestEvents([
      {
        eventId: 'ev-blocked-before',
        timestamp: 1000,
        actorId: 'agent-1',
        actionKind: 'TOOL_EXEC',
        binary: 'git',
        args: ['diff'],
        originalDecision: 'BLOCKED',
        policyRevision: 'rev-0.9',
      },
      {
        eventId: 'ev-cfg',
        timestamp: 2000,
        actorId: 'operator',
        actionKind: 'CONFIG_CHANGE',
        originalDecision: 'ALLOWED',
        policyRevision: 'rev-1.0',
      },
    ])

    const summary = daemon.replayAll()
    expect(summary.relaxedDecisionsCount).toBe(1)
    expect(summary.diffs[0]?.relaxedDetected).toBe(true)
    expect(summary.diffs[0]?.regressionDetected).toBe(false)
    expect(summary.overallStatus).toBe('CONFORMANT')
  })

  it('manages daemon lifecycle states cleanly without leaking open timers', () => {
    vi.useFakeTimers()
    try {
      const daemon = new WorkspacePolicyAuditReplayDaemon({
        initialSpec: BASE_PERMISSIVE_SPEC,
        intervalMs: 1000,
      })
      daemon.ingestEvents(SAMPLE_EVENTS)

      daemon.start()
      expect(daemon.getStatusReport().state).toBe('RUNNING')

      // Advance 1 interval -> replays 1 batch of 2 events
      vi.advanceTimersByTime(1000)
      expect(daemon.getStatusReport().totalEventsReplayed).toBe(2)

      daemon.pause()
      expect(daemon.getStatusReport().state).toBe('PAUSED')

      // Advancing while paused processes zero batches
      vi.advanceTimersByTime(2000)
      expect(daemon.getStatusReport().totalEventsReplayed).toBe(2)

      daemon.resume()
      expect(daemon.getStatusReport().state).toBe('RUNNING')
      vi.advanceTimersByTime(1000)
      expect(daemon.getStatusReport().totalEventsReplayed).toBe(4)

      daemon.stop()
      expect(daemon.getStatusReport().state).toBe('STOPPED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('validates policy spec and daemon interval contracts fail-closed', () => {
    expect(
      () =>
        new WorkspacePolicyAuditReplayDaemon({
          initialSpec: { ...BASE_PERMISSIVE_SPEC, specId: '  ' },
        }),
    ).toThrow(PolicyReplaySpecError)

    expect(
      () =>
        new WorkspacePolicyAuditReplayDaemon({
          initialSpec: { ...BASE_PERMISSIVE_SPEC, policyRevision: '' },
        }),
    ).toThrow(PolicyReplaySpecError)

    expect(
      () =>
        new WorkspacePolicyAuditReplayDaemon({
          initialSpec: { ...BASE_PERMISSIVE_SPEC, batchSize: 0 },
        }),
    ).toThrow(PolicyReplaySpecError)

    expect(
      () =>
        new WorkspacePolicyAuditReplayDaemon({
          initialSpec: BASE_PERMISSIVE_SPEC,
          intervalMs: -10,
        }),
    ).toThrow(PolicyReplaySpecError)
  })
})

import { describe, expect, it } from 'vitest'
import {
  WorkspaceCapabilityRevocationTripwire,
  type TripwireTrigger,
} from './workspaceCapabilityRevocationTripwire'

describe('WorkspaceCapabilityRevocationTripwire (CONFIG-030)', () => {
  it('grants capability leases and validates capability checks under ACTIVE_NOMINAL state', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    expect(tripwire.getState()).toBe('ACTIVE_NOMINAL')
    expect(tripwire.checkCapability('agent-1', 'FILE_WRITE')).toBe(true)

    const lease = tripwire.grantLease('agent-1', 'FILE_WRITE')
    expect(lease.leaseId).toBeDefined()
    expect(lease.subagentId).toBe('agent-1')
    expect(lease.capability).toBe('FILE_WRITE')
    expect(lease.isRevoked).toBe(false)

    const status = tripwire.getStatusReport()
    expect(status.state).toBe('ACTIVE_NOMINAL')
    expect(status.activeLeasesCount).toBe(1)
    expect(status.revokedLeasesCount).toBe(0)
  })

  it('triggers emergency global killswitch on CRITICAL anomaly revoking all active leases', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    tripwire.grantLease('agent-1', 'FILE_WRITE')
    tripwire.grantLease('agent-2', 'TOOL_EXEC')

    const trigger: TripwireTrigger = {
      reason: 'ESCAPE_SANDBOX_PROBE',
      severity: 'CRITICAL',
      details: 'Attempted to invoke forbidden chroot bypass in worker environment.',
    }

    const auditEntry = tripwire.triggerEmergencyKillswitch(trigger)

    expect(auditEntry.previousState).toBe('ACTIVE_NOMINAL')
    expect(auditEntry.newState).toBe('TRIPPED_GLOBAL')
    expect(auditEntry.revokedLeasesCount).toBe(2)
    expect(auditEntry.scope.isGlobal).toBe(true)
    expect(tripwire.getState()).toBe('TRIPPED_GLOBAL')

    // All capabilities blocked globally
    expect(tripwire.checkCapability('agent-1', 'FILE_WRITE')).toBe(false)
    expect(tripwire.checkCapability('agent-2', 'TOOL_EXEC')).toBe(false)
    expect(tripwire.checkCapability('agent-3', 'NETWORK_EGRESS')).toBe(false)

    // New leases granted are marked revoked immediately
    const postLease = tripwire.grantLease('agent-3', 'NETWORK_EGRESS')
    expect(postLease.isRevoked).toBe(true)
  })

  it('executes targeted revocation for a specific subagent on HIGH severity trigger', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    tripwire.grantLease('agent-rogue', 'NETWORK_EGRESS')
    tripwire.grantLease('agent-healthy', 'TOOL_EXEC')

    const trigger: TripwireTrigger = {
      reason: 'UNAUTHORIZED_OUTBOUND_EGRESS',
      severity: 'HIGH',
      sourceSubagentId: 'agent-rogue',
      targetCapabilities: ['NETWORK_EGRESS'],
      details: 'Suspicious HTTP outbound probe to external non-whitelisted IP.',
    }

    const audit = tripwire.triggerEmergencyKillswitch(trigger)

    expect(audit.newState).toBe('TRIPPED_TARGETED')
    expect(audit.scope.isGlobal).toBe(false)
    expect(audit.affectedSubagents).toContain('agent-rogue')

    // Rogue agent is blocked for NETWORK_EGRESS
    expect(tripwire.checkCapability('agent-rogue', 'NETWORK_EGRESS')).toBe(false)

    // Rogue agent is allowed for un-revoked capabilities if not globally blocked
    expect(tripwire.checkCapability('agent-rogue', 'FILE_WRITE')).toBe(true)

    // Healthy agent remains fully functional
    expect(tripwire.checkCapability('agent-healthy', 'TOOL_EXEC')).toBe(true)
  })

  it('broadcasts revocation events to listeners and isolates callback exceptions', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    let broadcastReceived = false

    // Faulty listener that throws
    tripwire.onRevocation(() => {
      throw new Error('Listener crashed')
    })

    // Healthy listener
    tripwire.onRevocation((entry) => {
      if (entry.trigger.reason === 'SECRET_LEAK_ATTEMPT') {
        broadcastReceived = true
      }
    })

    expect(() => {
      tripwire.triggerEmergencyKillswitch({
        reason: 'SECRET_LEAK_ATTEMPT',
        severity: 'CRITICAL',
      })
    }).not.toThrow()

    expect(broadcastReceived).toBe(true)
  })

  it('reinstates a targeted subagent and transitions back to ACTIVE_NOMINAL when all clear', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    tripwire.triggerEmergencyKillswitch({
      reason: 'ANOMALOUS_FILE_MODIFICATION',
      severity: 'HIGH',
      sourceSubagentId: 'agent-quarantine',
    })

    expect(tripwire.getState()).toBe('TRIPPED_TARGETED')
    expect(tripwire.checkCapability('agent-quarantine', 'FILE_WRITE')).toBe(false)

    const reinstated = tripwire.reinstateSubagent(
      'agent-quarantine',
      'Anomaly reviewed by security engineer and verified benign test runner output.',
    )
    expect(reinstated).toBe(true)
    expect(tripwire.getState()).toBe('ACTIVE_NOMINAL')
    expect(tripwire.checkCapability('agent-quarantine', 'FILE_WRITE')).toBe(true)
  })

  it('resets global killswitch when operator authorization key is supplied', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    tripwire.triggerEmergencyKillswitch({
      reason: 'MANUAL_OPERATOR_KILLSWITCH',
      severity: 'CRITICAL',
    })
    expect(tripwire.getState()).toBe('TRIPPED_GLOBAL')

    expect(() => tripwire.resetNominal('')).toThrow('Operator authorization key required')

    const resetSuccess = tripwire.resetNominal('OP-AUTH-KEY-88219')
    expect(resetSuccess).toBe(true)
    expect(tripwire.getState()).toBe('ACTIVE_NOMINAL')
    expect(tripwire.checkCapability('agent-1', 'TOOL_EXEC')).toBe(true)
  })

  it('maintains a comprehensive audit log history', () => {
    const tripwire = new WorkspaceCapabilityRevocationTripwire()

    tripwire.triggerEmergencyKillswitch({
      reason: 'POLICY_VIOLATION_THRESHOLD',
      severity: 'HIGH',
      sourceSubagentId: 'agent-1',
    })

    tripwire.reinstateSubagent('agent-1', 'False positive confirmed')

    const history = tripwire.getAuditHistory()
    expect(history).toHaveLength(2)
    expect(history[0]!.trigger.reason).toBe('POLICY_VIOLATION_THRESHOLD')
    expect(history[1]!.trigger.reason).toBe('MANUAL_OPERATOR_KILLSWITCH')
  })
})

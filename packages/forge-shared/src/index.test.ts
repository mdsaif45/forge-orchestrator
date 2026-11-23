import { describe, expect, it } from 'vitest'
import * as shared from './index'
import * as domain from './domain/index'
import * as views from './views/index'
import * as ipc from './ipc'
import * as app from './app'

describe('@forge/shared package exports', () => {
  it('exports core application constants', () => {
    expect(shared.APP_NAME).toBe('Forge')
    expect(app.APP_NAME).toBe('Forge')
    expect(shared.app.APP_NAME).toBe('Forge')
  })

  it('exports pure domain entities, branded IDs, and enums', () => {
    expect(shared.WORKFLOW_STATES).toBeDefined()
    expect(shared.TERMINAL_WORKFLOW_STATES).toBeDefined()
    expect(shared.workflowStateSchema).toBeDefined()
    expect(shared.projectSchema).toBeDefined()
    expect(shared.runIdSchema).toBeDefined()
    expect(shared.taskIdSchema).toBeDefined()
    expect(shared.domain.WORKFLOW_STATES).toEqual(shared.WORKFLOW_STATES)
    expect(domain.WORKFLOW_STATES).toEqual(shared.WORKFLOW_STATES)
  })

  it('exports FSM transitions and validation logic', () => {
    expect(typeof shared.canTransition).toBe('function')
    expect(typeof domain.canTransition).toBe('function')
    expect(shared.canTransition('DISCOVERY', 'start')).toBe(true)
    expect(shared.canTransition('DONE', 'start')).toBe(false)
  })

  it('exports read-model views and projections', () => {
    expect(shared.projectViewSchema).toBeDefined()
    expect(shared.workflowDetailViewSchema).toBeDefined()
    expect(shared.workflowSummaryViewSchema).toBeDefined()
    expect(shared.decisionViewSchema).toBeDefined()
    expect(views.projectViewSchema).toBeDefined()
    expect(shared.views.projectViewSchema).toBeDefined()
  })

  it('exports typed IPC contracts and envelope schemas', () => {
    expect(shared.IPC_CHANNELS).toBeDefined()
    expect(shared.IPC_ERROR_CODES).toBeDefined()
    expect(shared.appInfoSchema).toBeDefined()
    expect(ipc.IPC_CHANNELS).toEqual(shared.IPC_CHANNELS)
    expect(shared.ipc.IPC_CHANNELS).toEqual(shared.IPC_CHANNELS)
  })

  it('provides complete namespace exports for domain, views, ipc, and app', () => {
    expect(shared.domain).toBeDefined()
    expect(shared.views).toBeDefined()
    expect(shared.ipc).toBeDefined()
    expect(shared.app).toBeDefined()
  })
})

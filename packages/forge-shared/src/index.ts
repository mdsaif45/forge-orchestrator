/**
 * @forge/shared — Pure domain entities, branded IDs, FSM transitions,
 * view projections, and typed IPC contracts for Forge.
 */

// Disambiguate identifiers exported by both domain and views/ipc
export {
  toolCallEntrySchema,
  toolCallStatusSchema,
  type ToolCallEntry,
  type ToolCallStatus,
} from './domain/index'
export { appInfoSchema, type AppInfo } from './ipc'
export { APP_NAME } from './app'

export * from './domain/index'
export * from './views/index'
export * from './ipc'

export * as domain from './domain/index'
export * as views from './views/index'
export * as ipc from './ipc'
export * as app from './app'

import { describe, expect, it } from 'vitest'
import {
  appInfoSchema,
  IPC_CHANNELS,
  IPC_CONTRACT,
  isIpcChannel,
  repositoryProbeProblemSchema,
} from './ipc'

describe('IPC contract', () => {
  it('exposes every declared channel', () => {
    expect(IPC_CHANNELS).toEqual(Object.keys(IPC_CONTRACT))
    expect(IPC_CHANNELS.length).toBeGreaterThan(0)
  })

  it('declares a request and response schema for every channel', () => {
    for (const channel of IPC_CHANNELS) {
      const spec = IPC_CONTRACT[channel]
      expect(spec.request, `${channel} request`).toBeDefined()
      expect(spec.response, `${channel} response`).toBeDefined()
    }
  })

  describe('isIpcChannel', () => {
    it('accepts declared channels', () => {
      expect(isIpcChannel('app:getInfo')).toBe(true)
    })

    it('rejects undeclared channels', () => {
      expect(isIpcChannel('fs:readFile')).toBe(false)
      expect(isIpcChannel('')).toBe(false)
    })

    it('rejects non-string values', () => {
      expect(isIpcChannel(undefined)).toBe(false)
      expect(isIpcChannel(null)).toBe(false)
      expect(isIpcChannel(42)).toBe(false)
      expect(isIpcChannel({ channel: 'app:getInfo' })).toBe(false)
    })

    it('does not treat inherited Object properties as channels', () => {
      // A naive `value in CONTRACT` check would accept these, which would let a
      // renderer reach a channel that does not exist.
      expect(isIpcChannel('toString')).toBe(false)
      expect(isIpcChannel('constructor')).toBe(false)
      expect(isIpcChannel('__proto__')).toBe(false)
    })
  })

  describe('appInfoSchema', () => {
    const valid = {
      name: 'Forge',
      version: '0.0.1',
      platform: 'win32',
      versions: { electron: '43.4.0', chrome: '140', node: '22' },
    }

    it('accepts a well-formed payload', () => {
      expect(appInfoSchema.safeParse(valid).success).toBe(true)
    })

    it('rejects unknown keys rather than dropping them silently', () => {
      const result = appInfoSchema.safeParse({ ...valid, injected: 'value' })
      expect(result.success).toBe(false)
    })

    it('rejects a missing nested field', () => {
      const result = appInfoSchema.safeParse({
        ...valid,
        versions: { electron: '43.4.0', chrome: '140' },
      })
      expect(result.success).toBe(false)
    })

    it('rejects a wrong primitive type', () => {
      const result = appInfoSchema.safeParse({ ...valid, version: 1 })
      expect(result.success).toBe(false)
    })
  })
})

describe('project channels', () => {
  it('rejects a create request with a blank name', () => {
    const spec = IPC_CONTRACT['project:create']

    const result = spec.request.safeParse({
      name: '',
      repositoryPath: 'D:/Projects/InTime',
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    expect(result.success).toBe(false)
  })

  it('accepts a create request with nullable commands', () => {
    const spec = IPC_CONTRACT['project:create']

    const result = spec.request.safeParse({
      name: 'InTime',
      repositoryPath: 'D:/Projects/InTime',
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: ['.NET 9'],
      rules: ['never modify migrations'],
    })

    expect(result.success).toBe(true)
  })

  it('rejects an unknown probe problem code', () => {
    // The codes are a closed set so the renderer can branch on them without
    // matching message strings; a new reason must be declared on both sides.
    const result = repositoryProbeProblemSchema.safeParse({
      code: 'something-new',
      detail: 'x',
    })

    expect(result.success).toBe(false)
  })

  it('allows project:get to resolve null for an id that does not exist', () => {
    expect(IPC_CONTRACT['project:get'].response.safeParse(null).success).toBe(true)
  })
})

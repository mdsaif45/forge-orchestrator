import { describe, expect, it, vi } from 'vitest'
import { invokeChannel, type IpcHandlerMap } from './router'

const validInfo = {
  name: 'Forge',
  version: '0.0.1',
  platform: 'test',
  versions: { electron: 'x', chrome: 'y', node: 'z' },
}

const handlers: IpcHandlerMap = {
  'app:getInfo': () => validInfo,
}

describe('invokeChannel', () => {
  it('returns the validated value for a valid call', async () => {
    const result = await invokeChannel(handlers, 'app:getInfo', {})

    expect(result).toEqual({ ok: true, value: validInfo })
  })

  it('refuses an undeclared channel before any handler runs', async () => {
    const spy = vi.fn()
    const result = await invokeChannel({ 'app:getInfo': spy }, 'fs:readFile', { path: 'C:/secret' })

    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_CHANNEL' })
    // The important half: an unknown channel must not reach application code.
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a request with unknown keys', async () => {
    const spy = vi.fn(() => validInfo)
    const result = await invokeChannel({ 'app:getInfo': spy }, 'app:getInfo', { injected: true })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats a null or undefined request as empty', async () => {
    // The preload bridge always sends a payload, but Electron delivers `undefined`
    // if a call is made without one; that should be valid for an empty schema
    // rather than a confusing validation failure.
    await expect(invokeChannel(handlers, 'app:getInfo', undefined)).resolves.toMatchObject({
      ok: true,
    })
    await expect(invokeChannel(handlers, 'app:getInfo', null)).resolves.toMatchObject({ ok: true })
  })

  it('rejects a handler response of the wrong shape', async () => {
    const result = await invokeChannel(
      { 'app:getInfo': () => ({ name: 'Forge' }) as never },
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('converts a thrown error into a failure envelope', async () => {
    const result = await invokeChannel(
      {
        'app:getInfo': () => {
          throw new Error('disk exploded')
        },
      },
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'HANDLER_FAILED' })
    expect(result).toHaveProperty('message', expect.stringContaining('disk exploded'))
  })

  it('converts a rejected promise into a failure envelope', async () => {
    const result = await invokeChannel(
      { 'app:getInfo': () => Promise.reject(new Error('timed out')) },
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'HANDLER_FAILED' })
    expect(result).toHaveProperty('message', expect.stringContaining('timed out'))
  })

  it('describes a non-Error throw without crashing', async () => {
    const result = await invokeChannel(
      {
        'app:getInfo': () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'a bare string'
        },
      },
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'HANDLER_FAILED' })
    expect(result).toHaveProperty('message', expect.stringContaining('a bare string'))
  })

  it('never leaks a thrown value as a rejection', async () => {
    // The boundary contract is that failures arrive as data. If this rejects,
    // the renderer would see an opaque Electron error instead of a code.
    await expect(
      invokeChannel(
        {
          'app:getInfo': () => {
            throw new Error('boom')
          },
        },
        'app:getInfo',
        {},
      ),
    ).resolves.toBeDefined()
  })
})

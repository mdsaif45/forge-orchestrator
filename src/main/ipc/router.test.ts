import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc'
import { invokeChannel, type IpcHandlerMap } from './router'

const validInfo = {
  name: 'Forge',
  version: '0.0.1',
  platform: 'test',
  versions: { electron: 'x', chrome: 'y', node: 'z' },
}

/**
 * A complete handler map with only the channels under test implemented.
 *
 * `IpcHandlerMap` is total over the contract on purpose: that is what makes
 * `registerIpcHandlers` unable to leave a declared channel unhandled, and what
 * lets the router treat its own lookup as total. These tests used to pass a
 * one-entry object literal, which only compiled because nothing typechecked
 * them (#142) — widening the production type to a partial to accommodate that
 * would have traded a real guarantee for a test's convenience.
 *
 * The filler throws rather than returning a value: a test that reaches a channel
 * it did not set up should fail loudly instead of receiving something plausible.
 */
function handlerMap(overrides: Partial<IpcHandlerMap>): IpcHandlerMap {
  const map = Object.fromEntries(
    IPC_CHANNELS.map((channel) => [
      channel,
      () => {
        throw new Error(`No handler configured for "${channel}" in this test`)
      },
    ]),
  ) as Record<string, unknown>

  return { ...map, ...overrides } as IpcHandlerMap
}

const handlers: IpcHandlerMap = handlerMap({ 'app:getInfo': () => validInfo })

describe('invokeChannel', () => {
  it('returns the validated value for a valid call', async () => {
    const result = await invokeChannel(handlers, 'app:getInfo', {})

    expect(result).toEqual({ ok: true, value: validInfo })
  })

  it('refuses an undeclared channel before any handler runs', async () => {
    const spy = vi.fn()
    const result = await invokeChannel(handlerMap({ 'app:getInfo': spy }), 'fs:readFile', {
      path: 'C:/secret',
    })

    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_CHANNEL' })
    // The important half: an unknown channel must not reach application code.
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a request with unknown keys', async () => {
    const spy = vi.fn(() => validInfo)
    const result = await invokeChannel(handlerMap({ 'app:getInfo': spy }), 'app:getInfo', {
      injected: true,
    })

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
      handlerMap({ 'app:getInfo': () => ({ name: 'Forge' }) as never }),
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('converts a thrown error into a failure envelope', async () => {
    const result = await invokeChannel(
      handlerMap({
        'app:getInfo': () => {
          throw new Error('disk exploded')
        },
      }),
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'HANDLER_FAILED' })
    expect(result).toHaveProperty('message', expect.stringContaining('disk exploded'))
  })

  it('converts a rejected promise into a failure envelope', async () => {
    const result = await invokeChannel(
      handlerMap({ 'app:getInfo': () => Promise.reject(new Error('timed out')) }),
      'app:getInfo',
      {},
    )

    expect(result).toMatchObject({ ok: false, code: 'HANDLER_FAILED' })
    expect(result).toHaveProperty('message', expect.stringContaining('timed out'))
  })

  it('describes a non-Error throw without crashing', async () => {
    const result = await invokeChannel(
      handlerMap({
        'app:getInfo': () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'a bare string'
        },
      }),
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
        handlerMap({
          'app:getInfo': () => {
            throw new Error('boom')
          },
        }),
        'app:getInfo',
        {},
      ),
    ).resolves.toBeDefined()
  })
})

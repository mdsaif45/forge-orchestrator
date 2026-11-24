import { describe, expect, it } from 'vitest'
import { ForgeIpcError, unwrap } from './ipc'

describe('unwrap', () => {
  it('returns the value from a success envelope', () => {
    expect(unwrap({ ok: true, value: { id: 7 } })).toEqual({ id: 7 })
  })

  it('throws a typed error from a failure envelope', () => {
    expect(() => unwrap({ ok: false, code: 'UNKNOWN_CHANNEL', message: 'nope' })).toThrow(
      ForgeIpcError,
    )
  })

  it('preserves the code and message on the thrown error', () => {
    try {
      unwrap({ ok: false, code: 'INVALID_REQUEST', message: 'bad payload' })
      expect.unreachable('unwrap should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeIpcError)
      expect((error as ForgeIpcError).code).toBe('INVALID_REQUEST')
      expect((error as ForgeIpcError).message).toBe('bad payload')
      expect((error as ForgeIpcError).name).toBe('ForgeIpcError')
    }
  })

  it('produces a real Error, so existing handlers keep working', () => {
    // Callers commonly branch on `instanceof Error`; the class must not break it.
    const thrown = (() => {
      try {
        unwrap({ ok: false, code: 'HANDLER_FAILED', message: 'x' })
      } catch (error) {
        return error
      }
      return null
    })()

    expect(thrown).toBeInstanceOf(Error)
  })

  it('passes a falsy success value through unchanged', () => {
    // `ok` is the signal, not truthiness of the value — otherwise a legitimate
    // `false` or `0` response would be mistaken for a failure.
    expect(unwrap({ ok: true, value: false })).toBe(false)
    expect(unwrap({ ok: true, value: 0 })).toBe(0)
    expect(unwrap({ ok: true, value: null })).toBeNull()
  })
})

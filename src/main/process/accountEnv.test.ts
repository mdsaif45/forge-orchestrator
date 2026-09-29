import { describe, expect, it } from 'vitest'
import { accountEnv } from './accountEnv'

describe('accountEnv', () => {
  it('sets both HOME and USERPROFILE so child processes authenticate consistently', () => {
    const env = accountEnv('/test/accounts/a1/home')
    expect(env).toEqual({
      HOME: '/test/accounts/a1/home',
      USERPROFILE: '/test/accounts/a1/home',
    })
  })
})

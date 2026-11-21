import { describe, expect, it } from 'vitest'
import {
  CircularInterpolationError,
  interpolateConfigTree,
  interpolateEnvString,
  MissingEnvVariableError,
} from './envInterpolator'

describe('Environment Variable Interpolation Engine (CONFIG-007)', () => {
  it('interpolates direct environment variables', () => {
    const env = { FORGE_MODEL: 'qwen2.5-coder:7b', FORGE_PORT: '11434' }
    const res = interpolateEnvString('http://localhost:${FORGE_PORT}/model/${FORGE_MODEL}', { env })
    expect(res).toBe('http://localhost:11434/model/qwen2.5-coder:7b')
  })

  it('uses default fallback values when variables are unset or empty', () => {
    const env = { FORGE_ENDPOINT: '' }
    const res = interpolateEnvString(
      '${FORGE_ENDPOINT:-http://127.0.0.1:11434}/${UNSET_PATH:-api/tags}',
      { env },
    )
    expect(res).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('fails closed when required variable has no fallback default in strict mode', () => {
    const env = {}
    expect(() => interpolateEnvString('API key: ${REQUIRED_KEY}', { env, strict: true })).toThrow(
      MissingEnvVariableError,
    )
  })

  it('interpolates nested configuration trees with objects and arrays', () => {
    const env = {
      APP_ENV: 'staging',
      LOG_LEVEL: 'debug',
      DB_HOST: 'localhost',
    }

    const config = {
      profile: '${APP_ENV:-production}',
      settings: {
        logLevel: '${LOG_LEVEL}',
        endpoints: ['http://${DB_HOST}:5432', 'http://${UNSET_HOST:-db.internal}:5432'],
      },
      count: 42,
    }

    const resolved = interpolateConfigTree(config, { env })

    expect(resolved.profile).toBe('staging')
    expect(resolved.settings.logLevel).toBe('debug')
    expect(resolved.settings.endpoints).toEqual([
      'http://localhost:5432',
      'http://db.internal:5432',
    ])
    expect(resolved.count).toBe(42)
  })

  it('prevents infinite recursion on circular interpolations with bounded max depth', () => {
    const env = {
      LOOP_A: '${LOOP_B}',
      LOOP_B: '${LOOP_A}',
    }

    expect(() => interpolateEnvString('${LOOP_A}', { env, maxDepth: 5 })).toThrow(
      CircularInterpolationError,
    )
  })
})

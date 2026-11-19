import { describe, expect, it } from 'vitest'
import { isSensitiveKey, maskSecretValue, maskSensitiveConfig } from './configMasker'

describe('Sensitive Configuration Masking & Safe Diagnostic Sanitizer (CONFIG-008)', () => {
  it('detects sensitive property key names correctly', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('api_key')).toBe(true)
    expect(isSensitiveKey('secretVaultPassphrase')).toBe(true)
    expect(isSensitiveKey('authToken')).toBe(true)
    expect(isSensitiveKey('model')).toBe(false)
    expect(isSensitiveKey('maxRounds')).toBe(false)
  })

  it('masks short and long secret strings consistently', () => {
    expect(maskSecretValue('12345')).toBe('******')
    expect(maskSecretValue('sk-proj-1234567890abcdef')).toBe('sk-****ef')
    expect(maskSecretValue(12345)).toBe('[MASKED]')
  })

  it('recursively masks nested configuration structures while preserving benign fields', () => {
    const rawConfig = {
      profile: 'production',
      maxExecutionTimeMs: 30000,
      providers: {
        openai: {
          apiKey: 'sk-proj-secret-key-1234567890',
          endpointUrl: 'https://api.openai.com/v1',
        },
      },
      profiles: [
        {
          name: 'staging',
          vault: {
            passphrase: 'super-secret-passphrase',
          },
        },
      ],
    }

    const masked = maskSensitiveConfig(rawConfig)

    expect(masked.profile).toBe('production')
    expect(masked.maxExecutionTimeMs).toBe(30000)
    expect(masked.providers.openai.endpointUrl).toBe('https://api.openai.com/v1')
    expect(masked.providers.openai.apiKey).toBe('sk-****90')
    expect(masked.profiles[0]?.vault.passphrase).toBe('sup****se')
  })

  it('honors custom sensitive key patterns', () => {
    const config = {
      internalIdentifier: 'confidential-token-value',
      name: 'Forge',
    }

    const masked = maskSensitiveConfig(config, {
      customSensitiveKeys: ['internalIdentifier'],
    })

    expect(masked.internalIdentifier).toBe('con****ue')
    expect(masked.name).toBe('Forge')
  })
})

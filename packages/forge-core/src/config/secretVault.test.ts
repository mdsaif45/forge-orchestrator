import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getVaultSecret, listVaultSecrets, setVaultSecret } from './secretVault'

describe('secretVault (CONFIG-004)', () => {
  let tempDir: string
  let vaultPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-vault-test-'))
    vaultPath = join(tempDir, '.forgerc.vault')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('encrypts and decrypts secrets with correct passphrase (A7)', async () => {
    await setVaultSecret(vaultPath, 'OPENAI_API_KEY', 'sk-test-1234567890', 'master-passphrase')

    const retrieved = await getVaultSecret(vaultPath, 'OPENAI_API_KEY', 'master-passphrase')
    expect(retrieved).toBe('sk-test-1234567890')
  })

  it('fails closed with incorrect passphrase due to authentication tag mismatch (A2)', async () => {
    await setVaultSecret(vaultPath, 'OLLAMA_API_KEY', 'secret-val', 'correct-passphrase')

    await expect(getVaultSecret(vaultPath, 'OLLAMA_API_KEY', 'wrong-passphrase')).rejects.toThrow()
  })

  it('returns null for non-existent secret key', async () => {
    const missing = await getVaultSecret(vaultPath, 'NON_EXISTENT', 'pass')
    expect(missing).toBeNull()
  })

  it('lists secret keys without exposing decrypted contents', async () => {
    await setVaultSecret(vaultPath, 'KEY_ONE', 'val1', 'pass')
    await setVaultSecret(vaultPath, 'KEY_TWO', 'val2', 'pass')

    const summary = await listVaultSecrets(vaultPath)
    expect(summary.secretCount).toBe(2)
    expect(summary.secrets.map((s) => s.key)).toContain('KEY_ONE')
    expect(summary.secrets.map((s) => s.key)).toContain('KEY_TWO')
    expect(summary.formattedSummary).toContain('Total Encrypted Secrets: 2')
    expect(summary.formattedSummary).not.toContain('val1')
    expect(summary.formattedSummary).not.toContain('val2')
  })
})

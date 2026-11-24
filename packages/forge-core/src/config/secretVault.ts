import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface EncryptedSecretPayload {
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
  readonly updatedAt: string
}

export interface SecretVaultData {
  readonly version: 1
  readonly algorithm: 'aes-256-gcm'
  readonly salt: string
  readonly secrets: Record<string, EncryptedSecretPayload>
}

export interface SecretVaultSummary {
  readonly vaultPath: string
  readonly secretCount: number
  readonly secrets: readonly { readonly key: string; readonly updatedAt: string }[]
  readonly formattedSummary: string
}

/**
 * Derives a 256-bit encryption key from a user passphrase using PBKDF2 with SHA-256 (100,000 iterations).
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256')
}

/**
 * Encrypts sensitive secrets using authenticated AES-256-GCM.
 *
 * Implements Axiom A7 (Least privilege & security sandboxing):
 * Guarantees authenticated confidentiality and tamper detection for credentials.
 */
export function encryptSecret(
  plaintext: string,
  passphrase: string,
  salt: Buffer,
): Omit<EncryptedSecretPayload, 'updatedAt'> {
  const key = deriveKey(passphrase, salt)
  const iv = randomBytes(12) // 96-bit IV recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex')
  ciphertext += cipher.final('hex')
  const tag = cipher.getAuthTag().toString('hex')

  return {
    iv: iv.toString('hex'),
    tag,
    ciphertext,
  }
}

/**
 * Decrypts and authenticates AES-256-GCM ciphertext. Fails closed on incorrect passphrase or tampered data (A2).
 */
export function decryptSecret(
  payload: Omit<EncryptedSecretPayload, 'updatedAt'>,
  passphrase: string,
  salt: Buffer,
): string {
  const key = deriveKey(passphrase, salt)
  const iv = Buffer.from(payload.iv, 'hex')
  const tag = Buffer.from(payload.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

/**
 * Loads the encrypted secret vault from disk or initializes an empty vault structure.
 */
export async function loadSecretVault(rawVaultPath: string): Promise<SecretVaultData> {
  const vaultPath = resolve(rawVaultPath)
  if (!existsSync(vaultPath)) {
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      salt: randomBytes(16).toString('hex'),
      secrets: {},
    }
  }

  const raw = await readFile(vaultPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      parsed.version !== 1 ||
      typeof parsed.salt !== 'string' ||
      !parsed.secrets ||
      typeof parsed.secrets !== 'object'
    ) {
      throw new Error('Malformed vault schema')
    }
    return parsed as unknown as SecretVaultData
  } catch (err) {
    throw new Error(
      `Failed to parse secret vault at "${vaultPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/**
 * Writes the secret vault atomically to disk.
 */
export async function saveSecretVault(rawVaultPath: string, data: SecretVaultData): Promise<void> {
  const vaultPath = resolve(rawVaultPath)
  await writeFile(vaultPath, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Stores an encrypted secret in the vault.
 */
export async function setVaultSecret(
  vaultPath: string,
  key: string,
  value: string,
  passphrase: string,
): Promise<void> {
  const vault = await loadSecretVault(vaultPath)
  const salt = Buffer.from(vault.salt, 'hex')
  const encrypted = encryptSecret(value, passphrase, salt)

  vault.secrets[key] = {
    ...encrypted,
    updatedAt: new Date().toISOString(),
  }

  await saveSecretVault(vaultPath, vault)
}

/**
 * Retrieves and decrypts a secret from the vault.
 */
export async function getVaultSecret(
  vaultPath: string,
  key: string,
  passphrase: string,
): Promise<string | null> {
  const vault = await loadSecretVault(vaultPath)
  const entry = vault.secrets[key]
  if (!entry) return null

  const salt = Buffer.from(vault.salt, 'hex')
  return decryptSecret(entry, passphrase, salt)
}

/**
 * Lists metadata for all secrets in the vault without decrypting values.
 */
export async function listVaultSecrets(vaultPath: string): Promise<SecretVaultSummary> {
  const vault = await loadSecretVault(vaultPath)
  const secrets = Object.entries(vault.secrets).map(([key, v]) => ({
    key,
    updatedAt: v.updatedAt,
  }))

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Secret Vault: ${vaultPath}`)
  lines.push(`Total Encrypted Secrets: ${String(secrets.length)}`)
  lines.push('================================================================================')
  if (secrets.length === 0) {
    lines.push('  (No secrets currently stored in vault)')
  } else {
    for (const s of secrets) {
      lines.push(`  • ${s.key.padEnd(25)} (Updated: ${s.updatedAt})`)
    }
  }
  lines.push('================================================================================')

  return {
    vaultPath: resolve(vaultPath),
    secretCount: secrets.length,
    secrets,
    formattedSummary: lines.join('\n'),
  }
}

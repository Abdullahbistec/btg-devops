import crypto from 'crypto'
import { SecretClient } from '@azure/keyvault-secrets'
import { ClientSecretCredential } from '@azure/identity'

// Switch providers via SECRET_PROVIDER env var:
//   aes256   — local AES-256-GCM (development, default)
//   keyvault — Azure Key Vault (production)
const PROVIDER = process.env.SECRET_PROVIDER || 'aes256'

// ─── AES-256-GCM (Option 1) ──────────────────────────────────────────────────

function getAESKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY env var not set')
  const buf = Buffer.from(key, 'base64')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (base64-encoded)')
  return buf
}

function aesEncrypt(plaintext: string): string {
  const key = getAESKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

function aesDecrypt(stored: string): string {
  const key = getAESKey()
  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('Invalid AES encrypted format')
  const iv = Buffer.from(parts[0], 'hex')
  const authTag = Buffer.from(parts[1], 'hex')
  const enc = Buffer.from(parts[2], 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(enc).toString('utf8') + decipher.final('utf8')
}

// ─── Azure Key Vault (Option 2) ──────────────────────────────────────────────

function getKeyVaultClient(): SecretClient {
  const vaultUrl = process.env.KEYVAULT_URL
  if (!vaultUrl) throw new Error('KEYVAULT_URL env var not set')
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!
  )
  return new SecretClient(vaultUrl, credential)
}

async function kvEncrypt(plaintext: string): Promise<string> {
  const client = getKeyVaultClient()
  // Use a unique name per secret — timestamp + random suffix
  const secretName = `sub-secret-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await client.setSecret(secretName, plaintext)
  return secretName
}

async function kvDecrypt(secretName: string): Promise<string> {
  const client = getKeyVaultClient()
  const secret = await client.getSecret(secretName)
  if (!secret.value) throw new Error(`Key Vault secret '${secretName}' has no value`)
  return secret.value
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function encryptSecret(plaintext: string): Promise<string> {
  if (PROVIDER === 'keyvault') return kvEncrypt(plaintext)
  return aesEncrypt(plaintext)
}

export async function decryptSecret(stored: string): Promise<string> {
  if (PROVIDER === 'keyvault') return kvDecrypt(stored)
  return aesDecrypt(stored)
}

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/**
 * Same scheme as external/yomal/CLI Engine's internal/crypto/crypto.go
 * ("aes256" provider): AES-256-GCM, stored as hex-encoded
 * `iv:authTag:ciphertext`. That Go package only implements decrypt
 * (encryption happens on Yomal's dashboard side) — this file is both
 * directions, since our dashboard and analyzer runner live in one app.
 *
 * ENCRYPTION_KEY must be a base64-encoded 32-byte value, e.g.:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function getKey(): Buffer {
  const keyB64 = process.env.ENCRYPTION_KEY;
  if (!keyB64) throw new Error('ENCRYPTION_KEY env var not set');
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypts a value encrypted by encryptSecret(). Values that don't match
 * the iv:authTag:ciphertext shape (e.g. a pre-existing plaintext secret
 * seeded from an env var before this scheme existed) pass through
 * unchanged rather than throwing — callers always get a usable secret. */
export function decryptSecret(stored: string): string {
  if (!stored) return stored;
  const parts = stored.split(':');
  if (parts.length !== 3 || !/^[0-9a-f]+$/i.test(parts[0])) return stored;

  try {
    const key = getKey();
    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Malformed/undecryptable — most likely a plaintext secret that
    // happens to contain two colons. Return as-is rather than breaking
    // credential resolution.
    return stored;
  }
}

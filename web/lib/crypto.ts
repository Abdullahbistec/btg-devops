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

/** Exactly what encryptSecret() produces: a 12-byte IV and a 16-byte GCM
 * auth tag, hex-encoded — so 24 and 32 hex characters, not merely "some
 * hex". A plaintext secret that happens to contain two colons will not
 * match both fixed lengths, which is what makes the pass-through in
 * decryptSecret() safe to keep. */
const ENCRYPTED_SHAPE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;

/** Decrypts a value encrypted by encryptSecret(). A value that isn't in that
 * format (e.g. a pre-existing plaintext secret seeded from an env var before
 * this scheme existed) passes through unchanged.
 *
 * A value that IS in that format but fails to decrypt throws. It previously
 * returned `stored` — the raw ciphertext — which callers then handed to
 * Azure as a live client secret: every request failed with an opaque
 * authentication error and nothing anywhere pointed at the real cause, a
 * rotated or mismatched ENCRYPTION_KEY. Silently substituting undecryptable
 * bytes for a credential is never the recoverable outcome it looks like. */
export function decryptSecret(stored: string): string {
  if (!stored) return stored;
  if (!ENCRYPTED_SHAPE.test(stored)) return stored;

  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  try {
    const key = getKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (e) {
    throw new Error(
      'Failed to decrypt a stored secret — it is in encryptSecret() format but will not ' +
      'decrypt, which usually means ENCRYPTION_KEY no longer matches the key it was ' +
      `encrypted with. Underlying error: ${(e as Error).message}`
    );
  }
}

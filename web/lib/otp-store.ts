// Singleton OTP store — persists across hot-reloads in Next.js dev mode
interface OTPEntry {
  otp:      string;
  email:    string;
  expires:  number;   // ms timestamp
  attempts: number;
}

const g = global as unknown as { _btgOtp: Map<string, OTPEntry> };
if (!g._btgOtp) g._btgOtp = new Map();
export const otpStore = g._btgOtp;

const TTL_MS       = 5 * 60 * 1000;  // 5 minutes
const MAX_ATTEMPTS = 3;

export function generateOTP(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function createOTP(email: string): string {
  const otp = generateOTP();
  otpStore.set(email.toLowerCase(), {
    otp,
    email: email.toLowerCase(),
    expires:  Date.now() + TTL_MS,
    attempts: 0,
  });
  return otp;
}

export type VerifyResult = 'ok' | 'expired' | 'invalid' | 'locked';

export function verifyOTP(email: string, code: string): VerifyResult {
  const key   = email.toLowerCase();
  const entry = otpStore.get(key);
  if (!entry)              return 'expired';
  if (Date.now() > entry.expires) { otpStore.delete(key); return 'expired'; }
  if (entry.attempts >= MAX_ATTEMPTS) return 'locked';

  if (entry.otp !== code) {
    entry.attempts++;
    otpStore.set(key, entry);
    return entry.attempts >= MAX_ATTEMPTS ? 'locked' : 'invalid';
  }

  otpStore.delete(key);
  return 'ok';
}

export function clearOTP(email: string) {
  otpStore.delete(email.toLowerCase());
}

'use client';
import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const OTP_LEN = 6;
const TTL_SEC = 5 * 60; // 5 minutes
const RESEND_COOLDOWN = 60; // seconds before resend is allowed

export default function VerifyOTPPage() {
  return <Suspense><VerifyOTPInner /></Suspense>;
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.slice(0, 2) + '***';
  return `${masked}@${domain}`;
}

function VerifyOTPInner() {
  const router = useRouter();
  const params = useSearchParams();
  const emailRaw = params.get('email') ?? '';
  const devOtp   = params.get('dev') ?? '';
  const [digits, setDigits]       = useState<string[]>(Array(OTP_LEN).fill(''));
  const [error,   setError]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [success, setSuccess]     = useState(false);
  const [timeLeft, setTimeLeft]   = useState(TTL_SEC);
  const [resendCD, setResendCD]   = useState(RESEND_COOLDOWN);
  const [resending, setResending] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // OTP countdown
  useEffect(() => {
    const t = setInterval(() => setTimeLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  // Resend cooldown
  useEffect(() => {
    if (resendCD <= 0) return;
    const t = setInterval(() => setResendCD(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCD]);

  // Auto-submit when all 6 digits filled
  useEffect(() => {
    if (digits.every(d => d !== '') && !loading) submit(digits.join(''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  function handleChange(idx: number, val: string) {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[idx] = val;
    setDigits(next);
    setError('');
    if (val && idx < OTP_LEN - 1) inputRefs.current[idx + 1]?.focus();
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
    if (e.key === 'ArrowLeft'  && idx > 0)            inputRefs.current[idx - 1]?.focus();
    if (e.key === 'ArrowRight' && idx < OTP_LEN - 1)  inputRefs.current[idx + 1]?.focus();
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LEN);
    if (!pasted) return;
    const next = [...digits];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    inputRefs.current[Math.min(pasted.length, OTP_LEN - 1)]?.focus();
  }

  async function submit(otp: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => { router.push('/dashboard'); router.refresh(); }, 800);
      } else {
        setError(data.error ?? 'Verification failed');
        setDigits(Array(OTP_LEN).fill(''));
        setTimeout(() => inputRefs.current[0]?.focus(), 50);
        if (res.status === 429 || data.error?.includes('sign in again')) {
          setTimeout(() => router.push('/login'), 2500);
        }
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResending(true);
    setError('');
    try {
      const res = await fetch('/api/auth/resend-otp', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setDigits(Array(OTP_LEN).fill(''));
        setTimeLeft(TTL_SEC);
        setResendCD(RESEND_COOLDOWN);
        inputRefs.current[0]?.focus();
      } else {
        setError(data.error ?? 'Failed to resend');
      }
    } catch {
      setError('Network error');
    } finally {
      setResending(false);
    }
  }

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, '0');
  const ss = String(timeLeft % 60).padStart(2, '0');
  const expired = timeLeft === 0;
  const filled = digits.every(d => d !== '');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="glass" style={{ width: '100%', maxWidth: 400, borderRadius: 16, padding: '36px 32px 32px' }}>

        {/* Branding */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 10, flexShrink: 0,
            background: 'linear-gradient(135deg,#00C2FF 0%,#7B5EA7 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 900, color: '#fff',
            boxShadow: '0 4px 20px rgba(0,194,255,0.35)',
          }}>BTG</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>BTG DevOps</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>Security Console</div>
          </div>
        </div>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📧</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>
            Check your email
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            We sent a 6-digit verification code to{' '}
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {emailRaw ? maskEmail(emailRaw) : 'your email'}
            </span>.<br/>
            Enter it below to continue.
          </div>
        </div>

        {/* Dev-mode OTP hint */}
        {devOtp && (
          <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,193,7,0.1)', border: '1px solid rgba(255,193,7,0.35)', textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#FFC107', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
              Dev mode — SMTP not configured
            </div>
            <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 8, fontFamily: 'monospace', color: '#FFC107' }}>
              {devOtp}
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,193,7,0.6)', marginTop: 3 }}>
              Set SMTP_PASS in .env.local to send real emails
            </div>
          </div>
        )}

        {/* OTP boxes */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type="text" inputMode="numeric" maxLength={1}
              value={d}
              onChange={e => handleChange(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              onPaste={handlePaste}
              onFocus={e => e.currentTarget.select()}
              disabled={loading || success || expired}
              style={{
                width: 46, height: 54, textAlign: 'center',
                fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                background: success ? 'rgba(46,213,115,0.12)' : d ? 'rgba(0,194,255,0.08)' : 'rgba(0,0,0,0.25)',
                border: `2px solid ${
                  success ? 'var(--good)' :
                  error   ? 'var(--crit)' :
                  d       ? 'var(--accent)' : 'var(--border)'
                }`,
                borderRadius: 10,
                color: success ? 'var(--good)' : 'var(--text)',
                outline: 'none', fontFamily: 'Consolas,monospace',
                transition: 'border-color 0.15s, background 0.15s',
                caretColor: 'var(--accent)',
              }}
            />
          ))}
        </div>

        {/* Timer */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          {expired ? (
            <span style={{ fontSize: 12, color: 'var(--crit)', fontWeight: 600 }}>
              ⏱ Code expired
            </span>
          ) : (
            <span style={{ fontSize: 12, color: timeLeft < 60 ? 'var(--warn)' : 'var(--muted)' }}>
              Expires in{' '}
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
                {mm}:{ss}
              </span>
            </span>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 14, background: 'rgba(255,71,87,0.12)', border: '1px solid rgba(255,71,87,0.35)', color: 'var(--crit)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <span>⚠</span> {error}
          </div>
        )}

        {/* Success */}
        {success && (
          <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 14, background: 'rgba(46,213,115,0.12)', border: '1px solid rgba(46,213,115,0.35)', color: 'var(--good)', textAlign: 'center', fontWeight: 600 }}>
            ✓ Verified — opening dashboard…
          </div>
        )}

        {/* Verify button (fallback for when auto-submit didn't fire) */}
        {!success && (
          <button
            onClick={() => filled && submit(digits.join(''))}
            disabled={!filled || loading || expired}
            style={{
              width: '100%', padding: '11px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: loading ? 'rgba(0,194,255,0.15)' : 'linear-gradient(135deg,#00C2FF,#0094CC)',
              border: '1px solid rgba(0,194,255,0.4)',
              color: loading ? 'var(--accent)' : '#fff',
              cursor: (!filled || loading || expired) ? 'not-allowed' : 'pointer',
              opacity: (!filled || expired) ? 0.5 : 1,
              boxShadow: '0 4px 20px rgba(0,194,255,0.2)',
              marginBottom: 14,
            }}
          >
            {loading ? '⟳  Verifying…' : 'Verify Code →'}
          </button>
        )}

        {/* Resend */}
        <div style={{ textAlign: 'center' }}>
          {resendCD > 0 ? (
            <span style={{ fontSize: 12, color: 'var(--dim)' }}>
              Resend in <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>{resendCD}s</span>
            </span>
          ) : (
            <button onClick={handleResend} disabled={resending} style={{
              background: 'none', border: 'none', fontSize: 12, color: 'var(--accent)',
              cursor: resending ? 'not-allowed' : 'pointer', fontWeight: 600,
            }}>
              {resending ? '⟳ Sending…' : 'Resend code'}
            </button>
          )}
        </div>

        {/* Back to login */}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <a href="/login" style={{ fontSize: 11, color: 'var(--muted)' }}>← Back to sign in</a>
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center', fontSize: 10, color: 'var(--dim)' }}>
          BTG DevOps Security Console · Internal Use Only
        </div>
      </div>
    </div>
  );
}

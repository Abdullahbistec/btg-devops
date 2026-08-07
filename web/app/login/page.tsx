'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const router   = useRouter();
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.skipOtp) {
          router.push('/dashboard');
        } else {
          const params = new URLSearchParams({ email: email.trim().toLowerCase() });
          if (data.devOtp) params.set('dev', data.devOtp);
          router.push('/verify-otp?' + params.toString());
        }
      } else {
        setError(data.error ?? 'Login failed');
      }
    } catch {
      setError('Network error — server unreachable');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="glass" style={{ width: '100%', maxWidth: 400, borderRadius: 16, padding: '36px 32px 32px' }}>

        {/* Branding */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <svg width="42" height="47" viewBox="0 0 36 40" fill="none" style={{ flexShrink: 0, filter: 'drop-shadow(0 4px 16px rgba(0,194,255,0.4))' }}>
            <defs>
              <linearGradient id="lgHex" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#74D7F7" />
                <stop offset="100%" stopColor="#2B7FCC" />
              </linearGradient>
            </defs>
            <polygon points="18,1 34,10 34,30 18,39 2,30 2,10" fill="url(#lgHex)" />
            <circle cx="12.5" cy="20" r="5.5" fill="none" stroke="white" strokeWidth="2.2" />
            <circle cx="23.5" cy="20" r="5.5" fill="none" stroke="white" strokeWidth="2.2" />
            <rect x="15.5" y="14.5" width="5" height="11" fill="url(#lgHex)" />
          </svg>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontWeight: 300, color: 'var(--muted)', opacity: 0.6 }}>BTG</span>
              <span style={{ color: 'var(--accent)' }}>DevOps</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Security Console</div>
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Sign in</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>We'll send a verification code to your email</div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Email */}
          <Field label="Email">
            <InputIcon><MailIcon /></InputIcon>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@bistecglobal.com" autoComplete="email" required
              style={inputStyle(!!error)}
              onFocus={focusStyle} onBlur={e => blurStyle(e, !!error)}
            />
          </Field>

          {/* Password */}
          <Field label="Password">
            <InputIcon><LockIcon /></InputIcon>
            <input
              type={showPass ? 'text' : 'password'} value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="current-password" required
              style={{ ...inputStyle(!!error), paddingRight: 36 }}
              onFocus={focusStyle} onBlur={e => blurStyle(e, !!error)}
            />
            <button type="button" onClick={() => setShowPass(v => !v)} style={eyeBtnStyle}>
              {showPass ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </Field>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <button type="submit" disabled={loading || !email || !password} style={submitStyle(loading, !email || !password)}>
            {loading ? '⟳  Sending code…' : 'Continue →'}
          </button>
        </form>

        {/* Request Access panel */}
        <div style={{
          marginTop: 20, padding: '14px 16px', borderRadius: 10,
          background: 'rgba(0,194,255,0.06)', border: '1px solid rgba(0,194,255,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Need access?</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
              Admin approval required.<br />Submit a request to get started.
            </div>
          </div>
          <Link href="/register" style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '7px 14px', borderRadius: 7, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
            background: 'linear-gradient(135deg,#00C2FF,#0094CC)',
            color: '#fff', boxShadow: '0 3px 12px rgba(0,194,255,0.3)',
            border: '1px solid rgba(0,194,255,0.5)',
          }}>
            Request Access →
          </Link>
        </div>

        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 10, color: 'var(--dim)' }}>
          BTG DevOps Security Console · Internal Use Only
        </div>
      </div>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

function InputIcon({ children }: { children: React.ReactNode }) {
  return <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>{children}</span>;
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: 'rgba(255,71,87,0.12)', border: '1px solid rgba(255,71,87,0.35)', color: 'var(--crit)', display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ fontSize: 14 }}>⚠</span> {children}
    </div>
  );
}

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 34px',
    background: 'rgba(0,0,0,0.25)', border: `1px solid ${hasError ? 'var(--crit)' : 'var(--border)'}`,
    borderRadius: 8, color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  };
}
function focusStyle(e: React.FocusEvent<HTMLInputElement>) { e.currentTarget.style.borderColor = 'var(--accent)'; }
function blurStyle(e: React.FocusEvent<HTMLInputElement>, hasError: boolean) { e.currentTarget.style.borderColor = hasError ? 'var(--crit)' : 'var(--border)'; }
const eyeBtnStyle: React.CSSProperties = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 };
function submitStyle(loading: boolean, disabled: boolean): React.CSSProperties {
  return {
    marginTop: 6, padding: '11px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
    background: loading ? 'rgba(0,194,255,0.15)' : 'linear-gradient(135deg,#00C2FF 0%,#0094CC 100%)',
    border: '1px solid rgba(0,194,255,0.4)', color: loading ? 'var(--accent)' : '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, transition: 'opacity 0.15s',
    boxShadow: loading ? 'none' : '0 4px 20px rgba(0,194,255,0.25)',
  };
}

function MailIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--muted)" strokeWidth="1.5"><rect x="1" y="3" width="12" height="9" rx="2"/><path d="M1 5l6 4 6-4"/></svg>;
}
function LockIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--muted)" strokeWidth="1.5"><rect x="2" y="6" width="10" height="7" rx="2"/><path d="M4.5 6V4a2.5 2.5 0 015 0v2"/></svg>;
}
function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z"/><circle cx="7" cy="7" r="1.5"/></svg>;
}
function EyeOffIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M5.5 5.6A2.5 2.5 0 009.4 9.4M3 3.4C1.8 4.5 1 6 1 7s2.5 4.5 6 4.5c1.4 0 2.6-.4 3.6-1M11.5 5A8 8 0 0113 7"/></svg>;
}

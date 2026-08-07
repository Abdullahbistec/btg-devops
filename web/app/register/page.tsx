'use client';
import { useState, FormEvent } from 'react';
import Link from 'next/link';

export default function RegisterPage() {
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState(false);
  const [loading,  setLoading]  = useState(false);

  const passMatch = !confirm || password === confirm;
  const passStrong = password.length >= 8;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!passMatch)  return setError('Passwords do not match');
    if (!passStrong) return setError('Password must be at least 8 characters');
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email: email.trim().toLowerCase(), password }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
      } else {
        setError(data.error ?? 'Registration failed');
      }
    } catch {
      setError('Network error — server unreachable');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="glass" style={{ width: '100%', maxWidth: 420, borderRadius: 16, padding: '36px 32px 32px' }}>

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

        {success ? (
          /* Success state */
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
              Request submitted!
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 24 }}>
              Your access request has been sent to the admin.<br />
              You'll be notified once it's approved.
            </div>
            <Link href="/login" style={{
              display: 'inline-block', padding: '10px 24px', borderRadius: 8,
              background: 'linear-gradient(135deg,#00C2FF,#0094CC)',
              color: '#fff', fontWeight: 700, fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,194,255,0.25)',
            }}>
              Back to Sign In
            </Link>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Request Access</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                Submit your details — the admin will approve or reject your request.
              </div>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Full Name */}
              <Field label="Full Name">
                <InputIcon><PersonIcon /></InputIcon>
                <input type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your full name" autoComplete="name" required
                  style={inputStyle(false)} onFocus={focusStyle} onBlur={blurStyle}
                />
              </Field>

              {/* Email */}
              <Field label="Work Email">
                <InputIcon><MailIcon /></InputIcon>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@bistecglobal.com" autoComplete="email" required
                  style={inputStyle(false)} onFocus={focusStyle} onBlur={blurStyle}
                />
              </Field>

              {/* Password */}
              <Field label="Password">
                <InputIcon><LockIcon /></InputIcon>
                <input type={showPass ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters" autoComplete="new-password" required
                  style={{ ...inputStyle(!passStrong && password.length > 0), paddingRight: 36 }}
                  onFocus={focusStyle} onBlur={blurStyle}
                />
                <button type="button" onClick={() => setShowPass(v => !v)} style={eyeBtn}>
                  {showPass ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </Field>

              {/* Confirm Password */}
              <Field label="Confirm Password">
                <InputIcon><LockIcon /></InputIcon>
                <input type={showPass ? 'text' : 'password'} value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Repeat password" autoComplete="new-password" required
                  style={inputStyle(!passMatch && confirm.length > 0)}
                  onFocus={focusStyle} onBlur={blurStyle}
                />
              </Field>

              {/* Password strength hints */}
              {password.length > 0 && (
                <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
                  <span style={{ color: passStrong ? 'var(--good)' : 'var(--muted)' }}>
                    {passStrong ? '✓' : '○'} 8+ characters
                  </span>
                  {confirm.length > 0 && (
                    <span style={{ color: passMatch ? 'var(--good)' : 'var(--crit)' }}>
                      {passMatch ? '✓' : '✕'} Passwords match
                    </span>
                  )}
                </div>
              )}

              {error && (
                <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: 'rgba(255,71,87,0.12)', border: '1px solid rgba(255,71,87,0.35)', color: 'var(--crit)', display: 'flex', gap: 7 }}>
                  <span>⚠</span> {error}
                </div>
              )}

              <button type="submit"
                disabled={loading || !name || !email || !password || !confirm || !passMatch || !passStrong}
                style={{
                  marginTop: 6, padding: '11px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
                  background: loading ? 'rgba(123,94,167,0.15)' : 'linear-gradient(135deg,#7B5EA7,#5a3d8a)',
                  border: '1px solid rgba(123,94,167,0.5)',
                  color: loading ? '#7B5EA7' : '#fff',
                  cursor: (loading || !passMatch || !passStrong) ? 'not-allowed' : 'pointer',
                  opacity: (!name || !email || !password || !confirm || !passMatch || !passStrong) ? 0.5 : 1,
                  boxShadow: '0 4px 20px rgba(123,94,167,0.25)',
                  transition: 'opacity 0.15s',
                }}
              >
                {loading ? '⟳  Submitting…' : 'Submit Request →'}
              </button>
            </form>
          </>
        )}

        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
          Already have access?{' '}
          <Link href="/login" style={{ color: 'var(--accent)', fontWeight: 600 }}>Sign in</Link>
        </div>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)', textAlign: 'center', fontSize: 10, color: 'var(--dim)' }}>
          BTG DevOps Security Console · Internal Use Only
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</label>
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}
function InputIcon({ children }: { children: React.ReactNode }) {
  return <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>{children}</span>;
}
function inputStyle(hasError: boolean): React.CSSProperties {
  return { width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 34px', background: 'rgba(0,0,0,0.25)', border: `1px solid ${hasError ? 'var(--crit)' : 'var(--border)'}`, borderRadius: 8, color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.15s' };
}
function focusStyle(e: React.FocusEvent<HTMLInputElement>) { e.currentTarget.style.borderColor = 'var(--accent)'; }
function blurStyle(e: React.FocusEvent<HTMLInputElement>) { e.currentTarget.style.borderColor = 'var(--border)'; }
const eyeBtn: React.CSSProperties = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 };
function PersonIcon() { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--muted)" strokeWidth="1.5"><circle cx="7" cy="5" r="3"/><path d="M1.5 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></svg>; }
function MailIcon() { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--muted)" strokeWidth="1.5"><rect x="1" y="3" width="12" height="9" rx="2"/><path d="M1 5l6 4 6-4"/></svg>; }
function LockIcon() { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--muted)" strokeWidth="1.5"><rect x="2" y="6" width="10" height="7" rx="2"/><path d="M4.5 6V4a2.5 2.5 0 015 0v2"/></svg>; }
function EyeIcon() { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z"/><circle cx="7" cy="7" r="1.5"/></svg>; }
function EyeOffIcon() { return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M5.5 5.6A2.5 2.5 0 009.4 9.4M3 3.4C1.8 4.5 1 6 1 7s2.5 4.5 6 4.5c1.4 0 2.6-.4 3.6-1M11.5 5A8 8 0 0113 7"/></svg>; }

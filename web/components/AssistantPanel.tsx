'use client';
import { useState } from 'react';

interface Message {
  role: 'user' | 'assistant' | 'error';
  text: string;
}

export default function AssistantPanel({ auditId }: { auditId: string }) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  async function send(mode: 'chat' | 'summary') {
    const q = mode === 'chat' ? question.trim() : '';
    if (mode === 'chat' && !q) return;

    if (mode === 'chat') setMessages(m => [...m, { role: 'user', text: q }]);
    setQuestion('');
    setLoading(true);
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId, mode, question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assistant request failed');
      setMessages(m => [...m, { role: 'assistant', text: data.answer }]);
    } catch (e) {
      setMessages(m => [...m, { role: 'error', text: (e as Error).message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="glass" style={{ borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
          AI Assistant
        </span>
        <button
          onClick={() => send('summary')}
          disabled={loading}
          style={{
            fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6,
            background: 'var(--accent)22', color: 'var(--accent)', border: '1px solid var(--accent)66',
            cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
          }}
        >
          Summarize
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8,
            background: m.role === 'user' ? 'rgba(255,255,255,0.06)' : m.role === 'error' ? 'var(--crit)1A' : 'rgba(0,194,255,0.08)',
            color: m.role === 'error' ? 'var(--crit)' : 'var(--text)',
            alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
            whiteSpace: 'pre-wrap',
          }}>
            {m.text}
          </div>
        ))}
        {loading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Thinking…</div>}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !loading) send('chat'); }}
          placeholder="Ask about these findings…"
          disabled={loading}
          style={{
            flex: 1, fontSize: 12, padding: '8px 10px', borderRadius: 6,
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text)',
          }}
        />
        <button
          onClick={() => send('chat')}
          disabled={loading || !question.trim()}
          style={{
            fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 6,
            background: 'var(--accent)', color: '#04121c', border: 'none',
            cursor: loading ? 'default' : 'pointer', opacity: (loading || !question.trim()) ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

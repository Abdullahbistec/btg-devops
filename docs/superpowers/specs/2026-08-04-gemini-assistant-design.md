# Gemini Dashboard Assistant — Design

## Problem

Azure and Power Platform findings already live together in one `findings`
table, surfaced on one dashboard. There's no way to ask questions about that
data or get a written summary of it — a user has to read the charts/table
themselves. Add a Gemini-powered layer on top of the existing data.

## Scope (confirmed with user)

- Both a **chat box** (ask a question, get an answer) and a one-click
  **Summarize** button, sharing one backend endpoint.
- Scoped to whatever audit is currently resolved/selected on the dashboard —
  not all data across all subscriptions/audits.
- Dashboard only — not added to the Audits page.
- `GEMINI_API_KEY` in `.env.local`, same pattern as `AZURE_*` vars.
- Direct `fetch()` call to Google's Generative Language REST API
  (`gemini-2.0-flash`) — no new npm dependency, matching this project's
  existing preference for built-ins over SDKs (e.g. `node:sqlite` instead of
  `better-sqlite3`).

## Changes

1. **`web/.env.local.example`** — add `GEMINI_API_KEY=your-gemini-api-key`
   with a comment linking to https://aistudio.google.com/apikey.

2. **`web/lib/gemini.ts`** (new) — one function:
   ```ts
   export async function askGemini(prompt: string): Promise<string>
   ```
   POSTs to
   `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
   with the API key as a query param, throws with a clear message if
   `GEMINI_API_KEY` is unset or the API returns a non-200.

3. **`web/app/api/assistant/route.ts`** (new) — `POST` handler, body:
   ```ts
   { auditId?: string, question?: string, mode: 'chat' | 'summary' }
   ```
   - Loads findings for `auditId` via existing `listFindings(auditId)` and
     aggregate counts via existing `getDashboardStats(auditId)` from
     `lib/db.ts` — no new DB code.
   - Builds a compact text context: severity/service/category counts plus
     the top ~20 findings by severity (Critical first), not the full row
     set — keeps the prompt small.
   - `mode: 'summary'` → fixed prompt asking for a short executive risk
     summary.
   - `mode: 'chat'` → context + the user's `question`.
   - Calls `askGemini()`, returns `{ answer: string }`.
   - Already covered by the existing session-cookie middleware — no new
     auth code needed.

4. **`web/components/AssistantPanel.tsx`** (new) — added to
   `web/app/dashboard/page.tsx`:
   - A "Summarize" button and a single-line question input + send button.
   - Local React state for the conversation (not persisted — no new DB
     table; refreshing the page clears it).
   - Passes `data.resolvedAuditId` (already returned by `/api/dashboard`)
     as `auditId` so it matches whatever audit the dashboard is currently
     showing.

## Error handling

- Missing `GEMINI_API_KEY` → `/api/assistant` returns 500 with a clear
  message; panel shows it inline instead of a silent failure.
- Gemini API error (bad key, rate limit, etc.) → message surfaced as-is in
  the panel.
- Zero findings for the resolved audit → Gemini still answers using the
  "0 findings" context rather than the route short-circuiting.

## Testing

- No automated test harness exists for the `web/` app yet (a `vitest` test
  file is present but `vitest` was never added as a devDependency, so it
  doesn't currently run) — this is pre-existing and out of scope to fix
  here.
- Verify manually: `npm run build` for type-checking, then a `curl` smoke
  test of `POST /api/assistant` against the running dev server with a real
  `auditId` from the seeded DB, for both `mode: 'summary'` and
  `mode: 'chat'`.

## Out of scope

- No persistence of chat history.
- No use on the Audits page.
- No new npm dependency.

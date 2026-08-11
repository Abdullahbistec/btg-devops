// TypeScript port of CLI Engine/cmd/collect.go's triggerAnalyzerRoutine —
// the CLI fires this right after an automated audit queues analysis
// requests, but the dashboard's manual "Analyze" button (createAnalysisRequestController)
// never had an equivalent: it only inserted a pending row and relied
// entirely on the routine's own daily cron to eventually pick it up. That
// made a manual Analyze click look broken — nothing happens until the next
// cron tick, which can be up to a day away. Calling this after every new
// pending request closes that gap for both paths.
//
// Requires ROUTINE_TRIGGER_TOKEN (and optionally ANALYZER_ROUTINE_ID) to be
// set in the dashboard's own environment, same as the CLI's GitHub Actions
// secrets — best-effort: a missing token or failed call just logs and
// returns, since the routine's daily schedule is still a fallback.
const DEFAULT_ANALYZER_ROUTINE_ID = 'trig_016EuQk8v8sTJT8oiYrHbJau'

export async function triggerAnalyzerRoutine(): Promise<void> {
  const token = process.env.ROUTINE_TRIGGER_TOKEN
  if (!token) {
    console.warn('[analyzer-routine] ROUTINE_TRIGGER_TOKEN not set — skipping immediate trigger (will still run on its daily schedule)')
    return
  }
  const routineId = process.env.ANALYZER_ROUTINE_ID || DEFAULT_ANALYZER_ROUTINE_ID

  try {
    const res = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        text: 'A new analysis request was just queued from the dashboard — please process it now instead of waiting for the daily schedule.',
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[analyzer-routine] trigger returned ${res.status}: ${body}`)
    }
  } catch (e) {
    console.warn('[analyzer-routine] triggering analyzer routine failed:', e instanceof Error ? e.message : e)
  }
}

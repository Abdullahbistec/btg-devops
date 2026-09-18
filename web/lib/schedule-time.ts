/** Schedule timestamp helpers, shared by the scheduler poller
 * (lib/scheduler.ts) and the /api/schedule route. Both previously carried
 * their own copy of computeNextRun(), which is how the same timezone bug
 * came to exist in two places.
 *
 * The invariant: schedules.next_run_at and schedules.last_run_at are ALWAYS
 * UTC, in 'YYYY-MM-DD HH:MM:SS' form. Anything comparing against them must
 * render its own side in UTC too — see NOW_UTC_SQL. */

/** Renders a Date as the UTC 'YYYY-MM-DD HH:MM:SS' text form used by the
 * schedules table. */
export function toUtcTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** SQL fragment rendering Postgres' now() in UTC, in the same text form.
 *
 * `to_char(now(), ...)` alone renders in the *session* timezone, which is
 * whatever the server happens to be configured for. Comparing that against a
 * UTC next_run_at made schedules fire early or late by the server's offset —
 * on a +05:30 host, 5.5 hours early. The explicit AT TIME ZONE 'UTC' makes
 * the comparison correct regardless of session timezone. */
export const NOW_UTC_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

/** The next UTC instant at which a schedule with this frequency and hour is
 * due. `hour` is interpreted as an hour of the UTC day, matching the UTC
 * timestamps this returns — previously it was set in the server's local
 * timezone and then serialised to UTC, so the stored value silently depended
 * on the host's offset.
 *
 * `timesPerDay` only applies to 'daily' schedules (weekly/monthly ignore it)
 * and must evenly divide 24 — it spreads that many runs across the day at
 * equal spacing starting from `hour` (e.g. hour=0, timesPerDay=4 → 00:00,
 * 06:00, 12:00, 18:00 UTC), then rolls to the first slot of the next day once
 * every slot today has passed. Appended after `now` rather than inserted
 * before it so every existing 2- and 3-arg call site (defaulting to one run a
 * day) keeps working unchanged. */
export function computeNextRun(frequency: string, hour: number, now: Date = new Date(), timesPerDay = 1): string {
  const step = frequency === 'daily' && timesPerDay > 1 ? 24 / timesPerDay : 24;
  const slotHours = Array.from({ length: Math.max(1, 24 / step) }, (_, i) => (hour + i * step) % 24).sort((a, b) => a - b);

  for (const h of slotHours) {
    const candidate = new Date(now);
    candidate.setUTCHours(h, 0, 0, 0);
    if (candidate > now) return toUtcTimestamp(candidate);
  }

  // Every slot today has already passed — the first slot of the next period.
  const next = new Date(now);
  next.setUTCHours(slotHours[0], 0, 0, 0);
  if (frequency === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return toUtcTimestamp(next);
}

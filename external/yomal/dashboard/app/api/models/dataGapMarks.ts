import pool from './client'

export interface DataGapMark {
  subscription_id: string
  scope: string
  marked_at: string
  marked_by_email: string | null
  note: string | null
}

// Postgres "undefined_table" — thrown if this dashboard build is deployed
// before the next CLI-triggered audit has run ApplySchema and created
// data_gap_marks (schema.go is only applied by the Go CLI, not the
// dashboard). Both functions below degrade gracefully instead of hard-
// erroring the whole Data Gaps page during that window.
const UNDEFINED_TABLE = '42P01'

function isMissingTable(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNDEFINED_TABLE
}

// upsertDataGapMark records "an admin/analyst applied a fix for this
// subscription+scope, right now" — one row per (subscription, scope);
// re-marking replaces the previous mark rather than logging history, since
// only the most recent fix attempt matters for computing verification
// status (dataGaps.ts).
// Returns false (instead of throwing) if data_gap_marks doesn't exist yet —
// the caller surfaces that as "try again after the next audit runs" rather
// than a raw 500.
export async function upsertDataGapMark(
  subscriptionId: string,
  scope: string,
  markedBy: string,
  note?: string
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO data_gap_marks (subscription_id, scope, marked_by, marked_at, note)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (subscription_id, scope)
       DO UPDATE SET marked_by = $3, marked_at = NOW(), note = $4`,
      [subscriptionId, scope, markedBy, note || null]
    )
    return true
  } catch (e) {
    if (isMissingTable(e)) return false
    throw e
  }
}

// findAllDataGapMarks returns every mark, joined to the marking user's email
// — used by dataGaps.ts to compute verification status for every open gap
// and to find recently-resolved ones. Fetched in one query rather than
// per-scope, since the table is small (one row per subscription+scope ever
// marked).
export async function findAllDataGapMarks(): Promise<DataGapMark[]> {
  try {
    const { rows } = await pool.query(
      `SELECT m.subscription_id, m.scope, m.marked_at, m.note, u.email AS marked_by_email
       FROM data_gap_marks m
       LEFT JOIN users u ON u.id = m.marked_by`
    )
    return rows
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
}

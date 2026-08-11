import { findDataGaps } from '../models/dataGaps'
import { upsertDataGapMark } from '../models/dataGapMarks'

export async function listDataGapsController() {
  const view = await findDataGaps()
  return { data: view, status: 200 }
}

export async function markDataGapFixedController(
  userId: string,
  body: { subscription_id?: string; scope?: string; note?: string }
) {
  const { subscription_id, scope, note } = body
  if (!subscription_id || !scope) {
    return { error: 'subscription_id and scope are required', status: 400 }
  }
  const saved = await upsertDataGapMark(subscription_id, scope, userId, note)
  if (!saved) {
    // data_gap_marks doesn't exist yet — the Go CLI creates it via
    // ApplySchema on its next run (collect.go/seedadmin.go), not this
    // deploy. Tell the caller what's actually going on instead of a raw 500.
    return { error: 'Data gap tracking isn\'t set up yet — trigger an audit once, then try marking again.', status: 503 }
  }
  return { data: { marked: true }, status: 200 }
}

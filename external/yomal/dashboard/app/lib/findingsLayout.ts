// Which resource types get the "account → child" grouped findings layout
// (one card per account, e.g. Cosmos DB account or Storage account, with its
// databases/containers/apps nested inside) vs. the "flat, grouped by issue"
// layout (one card per issue pattern, tagging every affected resource).
// Shared between the analysis prompt (claude.ts, so the model knows when to
// populate child_resource_name vs. affected_resources) and the frontend
// layout-selection logic (AnalysisPanel.tsx).
export const ACCOUNT_BASED_TYPES = ['cosmosdb', 'storage', 'appserviceplan']

export function isAccountBasedType(resourceType: string): boolean {
  return ACCOUNT_BASED_TYPES.includes(resourceType)
}

export const SEVERITY_ORDER: Record<'Critical' | 'Warning' | 'Info', number> = { Critical: 0, Warning: 1, Info: 2 }

export const SEVERITY_DOT_COLOR: Record<'Critical' | 'Warning' | 'Info', string> = {
  Critical: '#ef4444',
  Warning: '#fbbf24',
  Info: '#38bdf8',
}

// Worst (lowest-numbered) severity among a set of findings — used to decide
// an account/group's overall severity for border color and expand state.
export function worstSeverity(severities: ('Critical' | 'Warning' | 'Info')[]): 'Critical' | 'Warning' | 'Info' {
  return severities.reduce((worst, s) => (SEVERITY_ORDER[s] < SEVERITY_ORDER[worst] ? s : worst), 'Info' as const)
}

// Shape rendered by the findings UI (AnalysisPanel + the two grouped
// layouts). Mirrors AnalysisFinding in api/utils/claude.ts — the LLM output
// shape — plus lifecycle fields that only exist on DB-backed rows (a cached
// analysis JSON blob predates status/first_seen_at tracking).
export interface DisplayFinding {
  severity: 'Critical' | 'Warning' | 'Info'
  category: string
  resource_type: string
  resource_name: string
  resource_group?: string | null
  child_resource_name?: string | null
  affected_resources?: string[] | null
  cost_impact_usd?: number | null
  cost_impact_note?: string | null
  issue: string
  evidence?: string | null
  recommendation: string
  recommendation_steps?: string[] | null
  fix_effort?: 'quick' | 'moderate' | 'complex' | null
  finding_type?: 'chain' | 'standard' | null
  id?: string
  status?: 'open' | 'resolved' | 'dismissed'
  first_seen_at?: string
}

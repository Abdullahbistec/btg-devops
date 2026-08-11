export type Role = 'admin' | 'analyst' | 'viewer'

export interface SessionUser {
  id: string
  email: string
  role: Role
}

export interface User {
  id: string
  email: string
  role: Role
  is_active: boolean
  created_at: string
  last_login: string | null
}

export interface Audit {
  id: string
  created_at: string
  subscription_id: string
  subscription_name: string
  trigger_type: string
  status: string
  current_step: string | null
  error_message: string
  resource_counts: Record<string, number>
  has_analysis: boolean
}

export interface AuditDetail extends Audit {
  raw_data: Record<string, unknown>
  claude_analysis: Record<string, unknown> | null
  has_cost: boolean
  has_usage: boolean
  usage_types: { slug: string; count: number }[]
}

// One currently-unresolved data gap (see app/api/types/index.ts for the
// backend definition — kept in sync manually, same pattern as Finding).
export interface DataGapEntry {
  subscription_id: string
  subscription_name: string
  scope: string
  gaps: string[]
  audit_id: string
  generated_at: string
  consecutive_runs: number
  verification_status: 'open' | 'pending_verification' | 'reopened'
  mark?: { marked_at: string; marked_by_email: string | null; note: string | null }
}

export interface ResolvedGapEntry {
  subscription_id: string
  subscription_name: string
  scope: string
  marked_at: string
  marked_by_email: string | null
  note: string | null
  resolved_at: string
}

export interface Finding {
  id: string
  audit_id: string
  severity: 'Critical' | 'Warning' | 'Info'
  category: string | null
  resource_type: string
  resource_name: string
  resource_group: string | null
  child_resource_name: string | null
  affected_resources: string[] | null
  cost_impact_usd: number | null
  cost_impact_note: string | null
  recommendation_steps: string[] | null
  fix_effort: 'quick' | 'moderate' | 'complex' | null
  finding_type: 'chain' | 'standard' | null
  issue: string
  evidence: string | null
  recommendation: string
  scope: string | null
  status: 'open' | 'resolved' | 'dismissed'
  first_seen_at: string
  resolved_at: string | null
  created_at: string
}

export interface ChatMessage {
  id: string
  audit_id: string
  thread_id?: string | null
  user_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  /** Transient UI-only field (not persisted): set when a 429/5xx forced a
   *  fallback away from the requested model for this reply. */
  fallback_model?: string
}

export interface ChatThread {
  id: string
  audit_id: string
  title: string
  created_at: string
  updated_at: string
  message_count?: number
}

export interface CostSummary {
  currency: string
  period_from: string
  period_to: string
  total_cost_rows: number
  daily_cost: { date: string; cost: number }[]
  top_services: { service: string; cost: number }[]
  total_resources_sampled: number
  usage_types: { slug: string; count: number }[]
  claude_analysis: Record<string, unknown> | null
  signals: CostUsageSignals
  resources: ResourceListEntry[]
  resources_truncated: boolean
}

export interface ResourceListEntry {
  resource_id: string
  resource_name: string
  resource_type: string | null
  total_cost_usd: number
  has_usage: boolean
  signals: ('zombie' | 'spike' | 'idle')[]
}

// Everything about ONE resource, for the resource-detail page — manually
// kept in sync with the backend's ResourceDetail (app/api/types/index.ts).
export interface ResourceDetail {
  resource_id: string
  resource_name: string
  resource_type: string | null
  resource_group: string | null
  currency: string
  daily_cost: { date: string; cost: number }[]
  total_cost_usd: number
  avg_daily_cost_usd: number
  usage_metrics: { metric_name: string; unit: string; avg: number | null; total: number | null }[]
  zombie: ZombieSpendFinding | null
  spend_spikes: SpendSpikeFinding[]
  idle: IdleResourceFinding[]
  findings: Finding[]
}

// Manually kept in sync with the backend's ResourceTypeSummary.
export interface ResourceTypeSummary {
  resource_type: string
  currency: string
  total_cost_usd: number
  resource_count: number
  flagged_count: number
  avg_utilization_pct: number | null
  daily_cost: { date: string; cost: number }[]
  findings: Finding[]
  resources: ResourceListEntry[]
}

// Manually kept in sync with the backend's CostUsageSignals
// (app/api/types/index.ts) — same pattern as Finding/DataGapEntry above.
// These are the same deterministic detectors fed to the LLM via
// buildPrecomputedSignals (app/api/utils/claude.ts), surfaced here directly.
export interface ZombieSpendFinding {
  resource_name: string
  resource_id: string
  last_service_name: string
  total_cost_usd: number
  first_cost_date: string
  last_cost_date: string
  billed_days: number
}

export interface SpendSpikeFinding {
  resource_name: string
  resource_id: string
  service_name: string
  spike_date: string
  spike_amount_usd: number
  baseline_daily_avg_usd: number
  z_score: number | null
  flat_baseline: boolean
}

export interface CostForecast {
  period_from: string
  period_to: string
  historical_daily_avg_usd: number
  run_rate_next_30_days_usd: number
  trend_daily_delta_usd: number
  trend_adjusted_next_30_days_usd: number
}

export interface IdleResourceFinding {
  resource_id: string
  resource_name: string
  resource_type: string
  metric_name: string
  avg: number | null
  total: number | null
  reason: string
}

export interface ResourceGroupCostRollup {
  resource_group: string
  total_cost_usd: number
  resource_count: number
}

export interface TagCostRollup {
  tag_key: string
  tag_value: string
  total_cost_usd: number
  resource_count: number
}

export interface CostUsageSignals {
  zombie_spend: ZombieSpendFinding[]
  spend_spikes: SpendSpikeFinding[]
  cost_forecast: CostForecast | null
  idle_resources: IdleResourceFinding[]
  cost_by_resource_group: ResourceGroupCostRollup[]
  cost_by_tag: TagCostRollup[]
}

export interface UsageSummary {
  type: string
  groups: {
    resource_id: string
    metrics: { metric_name: string; unit: string; avg: number | null; total: number | null }[]
  }[]
}

export interface RegionSummary {
  distribution: { region: string; count: number }[]
  mismatches: {
    region: string
    computeResources: { type: string; name: string }[]
    dataRegions: string[]
  }[]
}

export interface Subscription {
  id: string
  name: string
  subscription_id: string
  tenant_id: string
  client_id: string
  is_active: boolean
  created_at: string
  last_audit_at: string | null
}

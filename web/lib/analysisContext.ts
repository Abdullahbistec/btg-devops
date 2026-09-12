import { listFindings, getDashboardStats, getHetznerCostSnapshot } from '@/lib/db';

const TOP_FINDINGS_LIMIT = 20;

/**
 * Formats a single finding line. Byte-for-byte identical to the previous
 * inline format when the finding carries no cost, so the vast majority of
 * findings (all Azure ones today) are unaffected. Only appends a cost
 * suffix when monthly_cost is present.
 */
export function formatFindingLine(f: {
  severity: string; service: string; resource: string | null;
  description: string; monthly_cost: number | null; currency: string | null;
}): string {
  const base = `- [${f.severity}] ${f.service}/${f.resource || '(n/a)'}: ${f.description}`;
  if (f.monthly_cost == null) return base;
  // Compose the cost suffix from the parts that are actually present so a
  // stray " /mo" is never emitted in the first place. A blind
  // `.replace(' /mo', '/mo')` on the whole line would rewrite the FIRST
  // occurrence of that substring anywhere in the string, including inside
  // the finding's own description text.
  const costPart = `${f.monthly_cost.toFixed(2)}${f.currency ? ` ${f.currency}` : ''}/mo`;
  return `${base} — ${costPart}`;
}

/**
 * One currency's worth of summed finding cost. Findings are grouped by
 * currency before summing so amounts in different currencies are never
 * added together and mislabeled under a single symbol.
 */
export interface CurrencySubtotal {
  currency: string;
  total: number;
}

/** Sentinel label for costed findings whose currency is null/unknown. */
export const UNKNOWN_CURRENCY_LABEL = 'unknown currency';

/**
 * Builds the cost block appended to the audit context. The Hetzner run
 * rate is explicitly labeled as a list-price estimate (not a bill) since
 * the agent quotes this text verbatim into summaries.
 *
 * `findingsCostByCurrency` is a list of per-currency subtotals (never a
 * single blended number) — when there is exactly one currency the output
 * reads as a single total line; when there is more than one, each
 * currency's subtotal is reported separately.
 */
export function buildCostBlock(
  findingsCostByCurrency: CurrencySubtotal[],
  hetzner: { totalMonthly: number; currency: string } | null
): string {
  const lines: string[] = [];
  if (findingsCostByCurrency.length === 1) {
    const { currency, total } = findingsCostByCurrency[0];
    lines.push(`Estimated monthly cost attributable to findings: ${total.toFixed(2)} ${currency}`.trim());
  } else if (findingsCostByCurrency.length > 1) {
    lines.push('Estimated monthly cost attributable to findings (by currency, not summed):');
    for (const { currency, total } of findingsCostByCurrency) {
      lines.push(`  - ${total.toFixed(2)} ${currency}`);
    }
  }
  if (hetzner) {
    lines.push(
      `Hetzner run rate: ${hetzner.totalMonthly.toFixed(2)} ${hetzner.currency}/mo ` +
      `(list-price estimate, not a bill)`
    );
  }
  return lines.join('\n');
}

/**
 * True when a scope could plausibly include Hetzner resources — the
 * unscoped 'all' view, or a scope naming Hetzner explicitly (findings'
 * `service` field for Hetzner resources is one of the HETZNER_SERVICE_LABELS
 * values, e.g. "Hetzner Servers", "Hetzner Volumes").
 *
 * Without this guard, a scope-narrowed analysis (e.g. a single Azure
 * storage service) still got an unrelated Hetzner run-rate line injected
 * into its context — and the agent quotes verbatim what it's given, so an
 * Azure-storage-scoped summary would end up citing a Hetzner figure that
 * has nothing to do with the scope it was asked about.
 */
export function scopeIncludesHetzner(scope: string): boolean {
  return scope === 'all' || scope.toLowerCase().includes('hetzner');
}

/**
 * Builds the findings-summary text block consumed by the async MCP
 * get_audit_data tool — kept as its own function (not inlined into that
 * route) so a future second caller doesn't have to re-derive what
 * "context" means.
 */
export async function buildAuditContext(auditId?: string, scope: string = 'all'): Promise<string> {
  const stats = await getDashboardStats(auditId);
  let findings = await listFindings(auditId);
  if (scope !== 'all') {
    findings = findings.filter(f => f.service === scope);
  }

  const severityCounts = stats.bySeverity.map(s => `${s.severity}: ${s.count}`).join(', ');
  const serviceCounts = stats.byService.map(s => `${s.service}: ${s.count}`).join(', ');

  const severityOrder: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
  const top = [...findings]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))
    .slice(0, TOP_FINDINGS_LIMIT)
    .map(formatFindingLine)
    .join('\n');

  // Findings with no monthly_cost are omitted from the total entirely
  // (never treated as zero). Costed findings are grouped by currency
  // before summing — amounts in different currencies are never added
  // together, and a finding with no declared currency is never folded
  // into another currency's bucket. Currency is never hardcoded or
  // guessed; it always comes from the finding itself.
  const costedFindings = findings.filter(f => f.monthly_cost != null);
  const costByCurrency = new Map<string, number>();
  for (const f of costedFindings) {
    const key = f.currency ?? UNKNOWN_CURRENCY_LABEL;
    costByCurrency.set(key, (costByCurrency.get(key) ?? 0) + (f.monthly_cost as number));
  }
  const findingsCostByCurrency: CurrencySubtotal[] = Array.from(
    costByCurrency.entries(),
    ([currency, total]) => ({ currency, total })
  );

  const hetznerSnapshot = scopeIncludesHetzner(scope) ? await getHetznerCostSnapshot() : null;
  const hetzner = hetznerSnapshot
    ? { totalMonthly: hetznerSnapshot.total_monthly, currency: hetznerSnapshot.currency }
    : null;
  let costBlock = '';
  if (findingsCostByCurrency.length || hetzner) {
    costBlock = buildCostBlock(findingsCostByCurrency, hetzner);
  }

  return [
    scope !== 'all' ? `Scope: ${scope}` : '',
    `Total findings: ${findings.length}`,
    `By severity: ${severityCounts || 'none'}`,
    `By service: ${serviceCounts || 'none'}`,
    costBlock,
    findings.length ? `Top findings:\n${top}` : 'No findings recorded for this audit.',
  ].filter(Boolean).join('\n\n');
}

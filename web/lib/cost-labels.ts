// Pure cost-presentation labels shared between server code
// (costManagement.ts) and client components (app/cost/page.tsx).
// This file must never import Node built-ins or '@/lib/db' — anything here
// can end up in the browser bundle. Same rule as btg-commands.ts.

/** Bucket name for spend Azure reports with no resource group.
 *
 * Cost Management's ResourceGroup dimension comes back as an empty string
 * for charges that are not scoped to a resource group — Microsoft Entra ID
 * licences, Azure DevOps seats, Marketplace and reservation purchases,
 * support plans, subscription-scope Defender plans. It is real spend and
 * keeps its own bucket; the old '(none)' told you nothing about what it
 * was, which is the only thing this changes. */
export const NO_RESOURCE_GROUP = 'Subscription-level (no RG)';

/** The legacy value of the constant above. cost_snapshots.by_resource_group
 * stores already-aggregated JSON, so snapshots written before the rename
 * still carry this and get remapped on read rather than migrated. */
const LEGACY_NO_RESOURCE_GROUP = '(none)';

/** Resolves a raw ResourceGroup cell — or a name read back out of a stored
 * snapshot — to the name shown in the UI. Accepts unknown because callers
 * index straight into an untyped Cost Management row, where a missing
 * column yields undefined. */
export function resourceGroupLabel(raw: unknown): string {
  const name = String(raw ?? '').trim();
  return name === '' || name === LEGACY_NO_RESOURCE_GROUP ? NO_RESOURCE_GROUP : name;
}

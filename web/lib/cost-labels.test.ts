import { describe, it, expect } from 'vitest';

import { NO_RESOURCE_GROUP, resourceGroupLabel } from './cost-labels';

describe('resourceGroupLabel', () => {
  it('labels the empty ResourceGroup dimension Azure returns for subscription-level charges', () => {
    // Cost Management returns '' (not null, not a missing column) for charges
    // that are not scoped to a resource group — Entra ID licences, Azure
    // DevOps seats, Marketplace and reservation purchases, support plans.
    // That is real spend, so it keeps its own bucket; it just needs a name
    // that says what it is.
    expect(resourceGroupLabel('')).toBe(NO_RESOURCE_GROUP);
  });

  it('labels a whitespace-only resource group the same way', () => {
    expect(resourceGroupLabel('   ')).toBe(NO_RESOURCE_GROUP);
  });

  it('labels undefined the same way, for a response with no ResourceGroup column at all', () => {
    // findIndex returns -1 when the column is absent, and rawRows[-1] is
    // undefined — the caller indexes straight into the row, so this arrives
    // here rather than being guarded upstream.
    expect(resourceGroupLabel(undefined)).toBe(NO_RESOURCE_GROUP);
  });

  it("remaps the legacy '(none)' written into snapshots before this label existed", () => {
    // cost_snapshots.by_resource_group holds already-aggregated JSON, so rows
    // saved by the old code still carry '(none)'. Without this the same
    // bucket renders under two different names depending on when it was
    // fetched.
    expect(resourceGroupLabel('(none)')).toBe(NO_RESOURCE_GROUP);
  });

  it('passes a real resource group name through untouched', () => {
    expect(resourceGroupLabel('rg-bisteccare-fd')).toBe('rg-bisteccare-fd');
  });

  it('does not label anything with the bare placeholder the chart used to show', () => {
    expect(NO_RESOURCE_GROUP).not.toBe('(none)');
  });
});

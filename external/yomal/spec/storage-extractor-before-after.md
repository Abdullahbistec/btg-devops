# Extractor: Before vs After

Shows exactly what `ExtractPublicIP` (in [publicip.go](../CLI%20Engine/internal/extractors/publicip.go)) does to
a raw Azure API response, using the shared `CleanResource` helper in
[cleaner.go](../CLI%20Engine/internal/extractors/cleaner.go).

## Before — raw response from Azure (`armnetwork.PublicIPAddressesClient.List`)

```json
{
  "id": "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-prod-eastus/providers/Microsoft.Network/publicIPAddresses/pip-web01",
  "name": "pip-web01",
  "type": "Microsoft.Network/publicIPAddresses",
  "location": "eastus",
  "etag": "\"0x8DB1234ABCD5678\"",
  "systemData": {
    "createdBy": "admin@bistecglobal.com",
    "createdByType": "User",
    "createdAt": "2024-02-11T09:15:22.0000000Z"
  },
  "sku": {
    "name": "Standard",
    "tier": "Regional"
  },
  "properties": {
    "provisioningState": "Succeeded",
    "ipAddress": "20.185.10.44",
    "publicIPAllocationMethod": "Static",
    "publicIPAddressVersion": "IPv4",
    "idleTimeoutInMinutes": 4
  }
}
```

## After — cleaned output from the extractor

```json
{
  "name": "pip-web01",
  "location": "eastus",
  "sku": {
    "name": "Standard",
    "tier": "Regional"
  },
  "resourceGroup": "rg-prod-eastus",
  "properties": {
    "provisioningState": "Succeeded",
    "ipAddress": "20.185.10.44",
    "publicIPAllocationMethod": "Static",
    "publicIPAddressVersion": "IPv4",
    "idleTimeoutInMinutes": 4
  }
}
```

## Diff — what the extractor changed

| Field          | Before                                 | After              | What happened |
|----------------|-----------------------------------------|---------------------|---------------|
| `id`           | full ARM resource path                  | *(removed)*         | Read once to derive `resourceGroup`, then dropped — it added no analytical value on its own |
| `type`         | `"Microsoft.Network/publicIPAddresses"` | *(removed)*         | Noise field — always the same for a given extractor, not useful per-resource |
| `etag`         | `"0x8DB1234ABCD5678"`                   | *(removed)*         | Noise field — internal Azure concurrency token |
| `systemData`   | `createdBy`, `createdAt`, ...           | *(removed)*         | Noise field — audit metadata not needed for analysis |
| `resourceGroup`| *(did not exist)*                       | `"rg-prod-eastus"`  | **Added** — parsed out of the `id` path via regex before `id` was deleted |
| `name`, `location`, `sku`, `properties` | unchanged | unchanged | Kept as-is — this is the actual signal the extractor exists to preserve |

## Why this transform exists

Every extractor in this codebase runs raw Azure SDK objects through the same `CleanResource` step
(`cleaner.go:42-80`) before the data is stored in Postgres (`raw_data` column) or handed to the analyzer:

1. Drop fields that are pure Azure/ARM plumbing (`etag`, `systemData`, `type`) — they never carry a
   finding worth surfacing.
2. Recover `resourceGroup` from the `id` path, since for most resource types that is the *only* place
   the resource group name appears — then discard `id` itself, since nothing downstream needs the full ARM path.

The result is a smaller, flatter JSON object that keeps every field that matters for cost/security/usage
analysis and drops everything that doesn't.

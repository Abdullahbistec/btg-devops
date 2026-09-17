// Barrel: db.ts was split into per-domain repositories under lib/db/ (see
// docs/backend-engineering-review E-2 — getDB was a degree-85 hub). Every
// existing `import { ... } from '@/lib/db'` keeps working unchanged; the one
// shared pool lives in lib/db/core.ts and each domain file imports getDB from it.
export * from './db/core';
export * from './db/subscriptions';
export * from './db/audits';
export * from './db/findings';
export * from './db/users';
export * from './db/analysis';
export * from './db/cost';
export * from './db/dashboard';

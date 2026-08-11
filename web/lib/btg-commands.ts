// Pure command-list constants and types shared between server code (API
// routes, btg-runner.ts) and client components (e.g. app/audits/page.tsx).
// This file must never import Node built-ins (child_process, fs, path,
// etc.) — anything here can end up in the browser bundle.

export const AZURE_COMMANDS = [
  'appservice-traffic',
  'storage',
  'nsg',
  'acr',
  'cosmosdb',
  'keyvault',
  'functions',
  'publicip',
  'appserviceplan',
  'cognitiveservices',
  'resourcegroup',
  'iam',
  'sp-expiry',
  'idle',
] as const;

export const PP_COMMANDS = [
  'powerplatform',
  'pp-environments',
  'pp-apps',
  'pp-flows',
  'pp-powerbi',
] as const;

export const HETZNER_COMMANDS = [
  'hetzner-servers',
  'hetzner-volumes',
  'hetzner-floatingips',
  'hetzner-firewalls',
  'hetzner-certificates',
] as const;

export const ALL_COMMANDS = [...AZURE_COMMANDS, ...PP_COMMANDS, ...HETZNER_COMMANDS] as const;
export type Command = typeof ALL_COMMANDS[number];

// Service label strings produced by PP commands — used for scope filtering.
export const PP_SERVICE_LABELS = new Set([
  'Power Platform',
  'PP Environments',
  'PP Apps',
  'PP Flows',
  'Power BI',
]);

// Service label strings produced by Hetzner commands — used for scope filtering.
export const HETZNER_SERVICE_LABELS = new Set([
  'Hetzner Servers',
  'Hetzner Volumes',
  'Hetzner Floating IPs',
  'Hetzner Firewalls',
  'Hetzner Certificates',
]);

import {
  HardDrive, UserCheck, Shield, Container, Database, KeyRound,
  Zap, Globe, Layers, Brain, FolderTree, Network, Box, LucideIcon,
} from 'lucide-react'

interface ResourceMeta {
  label: string
  icon: LucideIcon
}

const META: Record<string, ResourceMeta> = {
  storage:           { label: 'Storage Accounts',        icon: HardDrive },
  iam:               { label: 'IAM Role Assignments',    icon: UserCheck },
  nsg:               { label: 'Network Security Groups', icon: Shield },
  acr:               { label: 'Container Registries',    icon: Container },
  cosmosdb:          { label: 'Cosmos DB',               icon: Database },
  keyvault:          { label: 'Key Vaults',              icon: KeyRound },
  functions:         { label: 'Function Apps',           icon: Zap },
  appservice:        { label: 'App Services',            icon: Globe },
  appserviceplan:    { label: 'App Service Plans',       icon: Layers },
  cognitiveservices: { label: 'Cognitive Services',      icon: Brain },
  resourcegroup:     { label: 'Resource Groups',         icon: FolderTree },
  publicip:          { label: 'Public IPs',              icon: Network },
}

export function resourceMeta(slug: string): ResourceMeta {
  return META[slug] || { label: slug, icon: Box }
}

export function ResourceIcon({ slug, size = 14, color = 'var(--t3)' }: { slug: string; size?: number; color?: string }) {
  const Icon = resourceMeta(slug).icon
  return <Icon size={size} color={color} />
}

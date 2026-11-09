import type { WorkflowWebhookConfig } from './types.ts'

export type WebhookDestination = NonNullable<WorkflowWebhookConfig['destinations']>[number]

/** Old published graphs have one URL instead of a destination list. */
export function webhookDestinations(config: WorkflowWebhookConfig | undefined): readonly WebhookDestination[] {
  if (config?.destinations !== undefined) return config.destinations
  return config?.url.trim() ? [{ id: 'default', name: '默认 Webhook', url: config.url }] : []
}

/** Missing selection preserves the old single-destination behavior. */
export function selectedWebhookDestinations(config: WorkflowWebhookConfig | undefined, ids: readonly string[] | undefined): readonly WebhookDestination[] {
  const destinations = webhookDestinations(config)
  if (ids === undefined) return destinations.slice(0, 1)
  const selected = new Set(ids)
  return destinations.filter(item => selected.has(item.id))
}

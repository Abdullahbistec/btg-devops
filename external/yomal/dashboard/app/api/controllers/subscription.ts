import { findAllSubscriptions, findSubscriptionById, insertSubscription, updateSubscription, deleteSubscription } from '../models/subscription'
import { encryptSecret } from '../utils/crypto'
import { JWTPayload } from '../types'

export async function listSubscriptionsController() {
  const subs = await findAllSubscriptions()
  return { data: subs, status: 200 }
}

export async function getSubscriptionController(id: string) {
  const sub = await findSubscriptionById(id)
  if (!sub) return { error: 'subscription not found', status: 404 }
  return { data: sub, status: 200 }
}

export async function createSubscriptionController(
  body: { name: string; subscription_id: string; tenant_id: string; client_id: string; client_secret: string },
  auth: JWTPayload
) {
  const { name, subscription_id, tenant_id, client_id, client_secret } = body
  if (!name || !subscription_id || !tenant_id || !client_id || !client_secret) {
    return { error: 'name, subscription_id, tenant_id, client_id and client_secret required', status: 400 }
  }
  const client_secret_enc = await encryptSecret(client_secret)
  const id = await insertSubscription(name, subscription_id, tenant_id, client_id, client_secret_enc, auth.user_id)
  return { data: { id }, status: 201 }
}

export async function updateSubscriptionController(
  id: string,
  body: { name?: string; tenant_id?: string; client_id?: string; client_secret?: string; is_active?: boolean }
) {
  const fields: Parameters<typeof updateSubscription>[1] = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.tenant_id !== undefined) fields.tenant_id = body.tenant_id
  if (body.client_id !== undefined) fields.client_id = body.client_id
  if (body.client_secret !== undefined) fields.client_secret_enc = await encryptSecret(body.client_secret)
  if (body.is_active !== undefined) fields.is_active = body.is_active

  const updated = await updateSubscription(id, fields)
  if (!updated) return { error: 'subscription not found or no fields to update', status: 404 }
  return { data: { message: 'updated' }, status: 200 }
}

export async function deleteSubscriptionController(id: string) {
  const deleted = await deleteSubscription(id)
  if (!deleted) return { error: 'subscription not found', status: 404 }
  return { data: { message: 'deleted' }, status: 200 }
}

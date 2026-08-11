import { findAllResources, findResourceBySlug, insertResource, updateResource, deleteResource } from '../models/resource'
import { findAuditResource } from '../models/audit'

export async function listResourcesController() {
  const resources = await findAllResources()
  return { data: resources, status: 200 }
}

export async function getAuditResourceController(auditId: string, slug: string) {
  const resource = await findResourceBySlug(slug)
  if (!resource) {
    return { error: 'unknown resource type: ' + slug, status: 404 }
  }

  const data = await findAuditResource(auditId, slug)
  if (!data) {
    return { error: 'no data for this resource in audit', status: 404 }
  }

  return { data: { audit_id: auditId, resource, data }, status: 200 }
}

export async function getResourceController(slug: string) {
  const resource = await findResourceBySlug(slug)
  if (!resource) return { error: 'resource not found', status: 404 }
  return { data: resource, status: 200 }
}

export async function createResourceController(body: { slug: string; name: string; description: string }) {
  const { slug, name, description } = body
  if (!slug || !name || !description) {
    return { error: 'slug, name and description required', status: 400 }
  }
  const id = await insertResource(slug, name, description)
  return { data: { id }, status: 201 }
}

export async function updateResourceController(slug: string, body: { name?: string; description?: string }) {
  const updated = await updateResource(slug, body)
  if (!updated) return { error: 'resource not found or no fields to update', status: 404 }
  return { data: { message: 'updated' }, status: 200 }
}

export async function deleteResourceController(slug: string) {
  const deleted = await deleteResource(slug)
  if (!deleted) return { error: 'resource not found', status: 404 }
  return { data: { message: 'deleted' }, status: 200 }
}

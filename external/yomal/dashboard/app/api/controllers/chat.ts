import {
  findThreadsByAudit, insertThread, findThreadById, updateThreadTitle, touchThread, deleteThread,
  findMessagesByThread, findMessagesByAudit, insertMessage, findMessageById, updateMessage, deleteMessage,
} from '../models/chat'
import { JWTPayload } from '../types'
import { runChat } from '../utils/claude'
import { LLMProvider } from '../utils/llm'
import { catalogLabel } from '../../lib/modelCatalog'

function coerceProvider(p?: string): LLMProvider | undefined {
  return p === 'claude' || p === 'gemini' || p === 'openrouter' ? p : undefined
}

// A thread's title is auto-taken from its first question, like most AI chat apps.
function titleFromQuestion(q: string): string {
  const line = q.trim().split('\n')[0]
  return line.length > 60 ? line.slice(0, 57) + '…' : line
}

export async function askChatController(
  auditId: string,
  content: string,
  auth: JWTPayload,
  provider?: string,
  model?: string,
  scope?: string,
  threadId?: string
) {
  if (!content || typeof content !== 'string') {
    return { error: 'content required', status: 400 }
  }

  // No thread yet (first message of a fresh conversation) → create one,
  // titled from the question itself.
  let thread = threadId ? await findThreadById(threadId) : null
  if (threadId && !thread) return { error: 'thread not found', status: 404 }
  if (thread && thread.audit_id !== auditId) return { error: 'thread does not belong to this audit', status: 400 }
  if (!thread) {
    thread = await insertThread(auditId, auth.user_id, titleFromQuestion(content))
  } else if (thread.title === 'New chat') {
    await updateThreadTitle(thread.id, titleFromQuestion(content))
  }

  const history = await findMessagesByThread(thread.id)
  await insertMessage(auditId, thread.id, auth.user_id, 'user', content)

  try {
    const result = await runChat(auditId, content, history, coerceProvider(provider), model || undefined, scope || undefined)
    if (result.error || !result.reply) {
      return { error: result.error || 'chat failed', status: result.status }
    }
    await insertMessage(auditId, thread.id, auth.user_id, 'assistant', result.reply)
    await touchThread(thread.id)
    return {
      data: {
        reply: result.reply,
        thread_id: thread.id,
        // Only set when a 429/5xx forced a switch away from the requested
        // model, so the UI can surface it — silent model swaps would be
        // confusing otherwise.
        fallback_model: result.usedFallback && result.usedProvider && result.usedModel
          ? catalogLabel(result.usedProvider, result.usedModel)
          : undefined,
      },
      status: 200,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'chat failed'
    return { error: message, status: 500 }
  }
}

export async function listThreadsController(auditId: string) {
  const threads = await findThreadsByAudit(auditId)
  return { data: threads, status: 200 }
}

export async function createThreadController(auditId: string, auth: JWTPayload) {
  const thread = await insertThread(auditId, auth.user_id, 'New chat')
  return { data: thread, status: 201 }
}

export async function deleteThreadController(auditId: string, threadId: string) {
  const thread = await findThreadById(threadId)
  if (!thread) return { error: 'thread not found', status: 404 }
  if (thread.audit_id !== auditId) return { error: 'thread does not belong to this audit', status: 400 }
  await deleteThread(threadId)
  return { data: { message: 'deleted' }, status: 200 }
}

// threadId narrows history to one conversation; without it, returns the
// audit's full history (legacy shape, still used by exports/debugging).
export async function listChatController(auditId: string, threadId?: string) {
  const messages = threadId ? await findMessagesByThread(threadId) : await findMessagesByAudit(auditId)
  return { data: messages, status: 200 }
}

export async function saveChatController(
  auditId: string,
  body: { role: string; content: string; thread_id?: string },
  auth: JWTPayload
) {
  const { role, content, thread_id } = body

  if (!role || !content) {
    return { error: 'role and content required', status: 400 }
  }
  if (role !== 'user' && role !== 'assistant') {
    return { error: 'role must be user or assistant', status: 400 }
  }

  let threadId = thread_id
  if (!threadId) {
    const thread = await insertThread(auditId, auth.user_id, titleFromQuestion(content))
    threadId = thread.id
  }

  await insertMessage(auditId, threadId, auth.user_id, role, content)
  return { data: { message: 'saved', thread_id: threadId }, status: 201 }
}

export async function getChatMessageController(messageId: number) {
  const msg = await findMessageById(messageId)
  if (!msg) return { error: 'message not found', status: 404 }
  return { data: msg, status: 200 }
}

export async function updateChatController(messageId: number, body: { content: string }) {
  if (!body.content) return { error: 'content required', status: 400 }
  const updated = await updateMessage(messageId, body.content)
  if (!updated) return { error: 'message not found', status: 404 }
  return { data: { message: 'updated' }, status: 200 }
}

export async function deleteChatController(messageId: number) {
  const deleted = await deleteMessage(messageId)
  if (!deleted) return { error: 'message not found', status: 404 }
  return { data: { message: 'deleted' }, status: 200 }
}

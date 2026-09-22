import { resolveModelId } from '../config/models'

// A chat's stored `model` can go stale when that model id is later retired from
// config/models.ts. A read swaps in its successor (or DEFAULT_CHAT_MODEL when it has none) in the
// response only and reports what changed so the client can show a notice; the row is left alone
// until the next send persists whatever model it used. See
// docs/adr/0050-retired-models-hand-off-to-a-successor.md and
// docs/adr/0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md. Message rows
// keep their own historical `model` field, so past turns still show what generated them.
export function resolveChatModel(chat: Record<string, unknown>): { model: string; modelMigratedFrom?: string } {
  const { model, migratedFrom } = resolveModelId(chat.model as string)
  return migratedFrom ? { model, modelMigratedFrom: migratedFrom } : { model }
}

// Chat item -> client DTO. Shared by the list and single-chat GET routes so both expose the
// same shape — sensitive chats ARE included (the sidebar eye/mask handles visibility, not the
// API), only their content (memory/summary/search) is excluded elsewhere.
export function chatDto(i: Record<string, unknown>) {
  const chatId = (i.SK as string).replace('CHAT#', '')
  const { model, modelMigratedFrom } = resolveChatModel(i)
  return {
    chatId,
    title: i.title,
    model,
    systemPrompt: i.systemPrompt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ...(i.lastMessageAt !== undefined ? { lastMessageAt: i.lastMessageAt } : {}),
    ...(i.activeLeafId !== undefined ? { activeLeafId: i.activeLeafId } : {}),
    ...(i.modelSettings !== undefined ? { modelSettings: i.modelSettings } : {}),
    ...(i.projectId !== undefined ? { projectId: i.projectId } : {}),
    ...(i.summary !== undefined ? { summary: i.summary } : {}),
    ...(i.topics !== undefined ? { topics: i.topics } : {}),
    ...(i.sensitive === true ? { sensitive: true } : {}),
    ...(i.ephemeral === true ? { ephemeral: true, expiresAt: new Date((i.ttl as number) * 1000).toISOString() } : {}),
    ...(modelMigratedFrom ? { modelMigratedFrom } : {}),
  }
}

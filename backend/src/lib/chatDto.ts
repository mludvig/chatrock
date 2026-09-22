import { migrateChatModel } from './dynamo'
import { DEFAULT_CHAT_MODEL, isValidModelId } from '../config/models'

// A chat's stored `model` can go stale when that model id is later retired from
// config/models.ts (e.g. a renamed inference profile with no back-compat alias). Rather than a
// bulk migration, this self-heals lazily the next time the chat is read: swap in
// DEFAULT_CHAT_MODEL and report what changed so the client can show a one-time notice. Only
// affects the NEXT message — Message rows keep their own historical `model` field untouched, so
// past turns still show what actually generated them.
export async function resolveChatModel(sub: string, chatId: string, chat: Record<string, unknown>): Promise<{ model: string; modelMigratedFrom?: string }> {
  const model = chat.model as string
  if (isValidModelId(model)) return { model }
  await migrateChatModel(sub, chatId, DEFAULT_CHAT_MODEL)
  console.log(JSON.stringify({ event: 'chat_model_migrated', sub, chatId, from: model, to: DEFAULT_CHAT_MODEL }))
  return { model: DEFAULT_CHAT_MODEL, modelMigratedFrom: model }
}

// Chat item -> client DTO. Shared by the list and single-chat GET routes so both expose the
// same shape — sensitive chats ARE included (the sidebar eye/mask handles visibility, not the
// API), only their content (memory/summary/search) is excluded elsewhere.
export async function chatDto(sub: string, i: Record<string, unknown>) {
  const chatId = (i.SK as string).replace('CHAT#', '')
  const { model, modelMigratedFrom } = await resolveChatModel(sub, chatId, i)
  return {
    chatId,
    title: i.title,
    model,
    systemPrompt: i.systemPrompt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
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

import { getProjectFile, listMessages, getChat } from './dynamo'
import { buildActivePath, type TurnRow } from './tree'
import { capToolResultText } from './blocks'
import { fetchS3Text, fetchS3Bytes } from './projectFiles'
import type { ToolResultBlock } from '@aws-sdk/client-bedrock-runtime'
import type { ToolContext } from './tools'

const TRANSCRIPT_TURNS_CAP = 40

export async function executeProjectReadFileTool(
  input: Record<string, string>,
  ctx: ToolContext,
): Promise<ToolResultBlock> {
  const { fileId, detail } = input
  if (!fileId || !ctx.projectId) {
    return { toolUseId: '', content: [{ text: 'Missing fileId or project context' }], status: 'error' }
  }

  const file = await getProjectFile(ctx.projectId, fileId)
  if (!file) {
    return { toolUseId: '', content: [{ text: `File ${fileId} not found in this project` }], status: 'error' }
  }

  if (detail === 'summary' || !detail) {
    const text = [
      `File: ${file.filename as string}`,
      `Micro-label: ${(file.microLabel as string | undefined) ?? '(none)'}`,
      `Summary: ${(file.summary as string | undefined) ?? '(no summary available)'}`,
    ].join('\n')
    return { toolUseId: '', content: [{ text }], status: 'success' }
  }

  if (detail === 'full') {
    const contentType = file.contentType as string
    const s3Key = file.s3Key as string
    const extractedTextKey = file.extractedTextKey as string | undefined

    if (isTextLike(contentType)) {
      // Use extracted text sidecar if available, else original
      const keyToRead = extractedTextKey ?? s3Key
      try {
        const raw = await fetchS3Text(keyToRead)
        const capped = capToolResultText(raw)
        const header = `File: ${file.filename as string}\n\n`
        return { toolUseId: '', content: [{ text: header + capped }], status: 'success' }
      } catch {
        return { toolUseId: '', content: [{ text: `Could not read file content: ${file.filename as string}` }], status: 'error' }
      }
    }

    if (contentType === 'application/pdf') {
      if (extractedTextKey) {
        try {
          const raw = await fetchS3Text(extractedTextKey)
          const capped = capToolResultText(raw)
          return { toolUseId: '', content: [{ text: `File: ${file.filename as string}\n\n${capped}` }], status: 'success' }
        } catch { /* fall through to summary */ }
      }
      // No extracted text — return summary with a note
      const text = `File: ${file.filename as string}\n\nFull text not available for this PDF. Summary:\n${(file.summary as string | undefined) ?? '(no summary)'}`
      return { toolUseId: '', content: [{ text }], status: 'success' }
    }

    if (contentType.startsWith('image/')) {
      // Return image bytes as an image content block
      try {
        const bytes = await fetchS3Bytes(s3Key)
        const format = contentType.split('/')[1] as 'png' | 'jpeg' | 'gif' | 'webp'
        return {
          toolUseId: '',
          content: [{ image: { format, source: { bytes } } } as unknown as { text: string }],
          status: 'success',
        }
      } catch {
        return { toolUseId: '', content: [{ text: `File: ${file.filename as string}\n\nSummary: ${(file.summary as string | undefined) ?? '(no summary)'}` }], status: 'success' }
      }
    }

    // Binary/unknown — return summary
    return {
      toolUseId: '',
      content: [{ text: `File: ${file.filename as string}\n\nBinary file — full content not available.\nSummary: ${(file.summary as string | undefined) ?? '(no summary)'}` }],
      status: 'success',
    }
  }

  return { toolUseId: '', content: [{ text: `Unknown detail level: ${detail}` }], status: 'error' }
}

export async function executeProjectReadChatTool(
  input: Record<string, string>,
  ctx: ToolContext,
): Promise<ToolResultBlock> {
  const { chatId: targetChatId, detail } = input
  if (!targetChatId || !ctx.projectId || !ctx.sub) {
    return { toolUseId: '', content: [{ text: 'Missing chatId or project context' }], status: 'error' }
  }

  // Reject reading the current chat (use the conversation directly)
  if (targetChatId === ctx.chatId) {
    return { toolUseId: '', content: [{ text: 'Cannot read the current chat — it is already in your context.' }], status: 'error' }
  }

  // Verify ownership: the chat must belong to this project
  const chat = await getChat(ctx.sub, targetChatId)
  if (!chat || chat.projectId !== ctx.projectId) {
    return { toolUseId: '', content: [{ text: `Chat ${targetChatId} not found in this project` }], status: 'error' }
  }

  if (detail === 'summary' || !detail) {
    const summary = (chat.summary as string | undefined) ?? '(no summary yet)'
    return {
      toolUseId: '',
      content: [{ text: `Chat: ${chat.title as string}\n\nSummary: ${summary}` }],
      status: 'success',
    }
  }

  if (detail === 'full') {
    try {
      const rows = await listMessages(targetChatId)
      if (rows.length === 0) {
        return { toolUseId: '', content: [{ text: `Chat: ${chat.title as string}\n\n(no messages)` }], status: 'success' }
      }
      const typedRows = rows as unknown as TurnRow[]
      const leaf = typedRows[typedRows.length - 1]
      const path = buildActivePath(typedRows, leaf.msgId)
      const transcript = path
        .filter(r => r.role === 'user' || r.role === 'assistant')
        .slice(-TRANSCRIPT_TURNS_CAP)
        .map(r => {
          const blocks = (r.blocks as Array<{ text?: string }> | undefined) ?? []
          const text = blocks.map(b => b.text ?? '').filter(Boolean).join(' ')
          return `${r.role === 'user' ? 'User' : 'Assistant'}: ${text}`
        })
        .join('\n\n')
      const capped = capToolResultText(`Chat: ${chat.title as string}\n\n${transcript}`)
      return { toolUseId: '', content: [{ text: capped }], status: 'success' }
    } catch {
      return { toolUseId: '', content: [{ text: `Could not load chat transcript for: ${chat.title as string}` }], status: 'error' }
    }
  }

  return { toolUseId: '', content: [{ text: `Unknown detail level: ${detail}` }], status: 'error' }
}

function isTextLike(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType === 'application/octet-stream'
}

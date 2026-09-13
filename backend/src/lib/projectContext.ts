import { getProjectFile, listMessages, getChat } from './dynamo'
import { buildActivePath, type TurnRow } from './tree'
import { capToolResultText } from './llm/blocks'
import { fetchS3Text, fetchS3Bytes } from './projectFiles'
import type { ToolResult, ToolResultEntry } from './llm/toolSpec'
import type { ToolContext } from './tools'

const TRANSCRIPT_TURNS_CAP = 40

function textResult(text: string, isError = false): ToolResult {
  return { entries: [{ kind: 'text', text }], isError }
}
function errorResult(text: string): ToolResult {
  return textResult(text, true)
}

export async function executeProjectReadFileTool(
  input: Record<string, string>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { fileId, detail } = input
  if (!fileId || !ctx.projectId) {
    return errorResult('Missing fileId or project context')
  }

  const file = await getProjectFile(ctx.projectId, fileId)
  if (!file || file.inclusion === 'never' || file.status === 'error' || file.status === 'processing' || file.status === 'uploading') {
    return errorResult(`File ${fileId} not found in this project`)
  }

  if (detail === 'summary' || !detail) {
    const text = [
      `File: ${file.filename as string}`,
      `Micro-label: ${(file.microLabel as string | undefined) ?? '(none)'}`,
      `Summary: ${(file.summary as string | undefined) ?? '(no summary available)'}`,
    ].join('\n')
    return textResult(text)
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
        return textResult(header + capped)
      } catch {
        return errorResult(`Could not read file content: ${file.filename as string}`)
      }
    }

    if (contentType === 'application/pdf') {
      if (extractedTextKey) {
        try {
          const raw = await fetchS3Text(extractedTextKey)
          const capped = capToolResultText(raw)
          return textResult(`File: ${file.filename as string}\n\n${capped}`)
        } catch { /* fall through to raw bytes */ }
      }
      // No extracted text — send raw PDF bytes as a document entry
      try {
        const bytes = await fetchS3Bytes(s3Key)
        const docName = (file.filename as string).replace(/\.pdf$/i, '').slice(0, 200) || 'document'
        const entries: ToolResultEntry[] = [
          { kind: 'document', format: 'pdf', name: docName, bytes },
          { kind: 'text', text: 'The complete PDF is included above.' },
        ]
        return { entries, isError: false }
      } catch {
        const text = `File: ${file.filename as string}\n\nCould not read PDF content. Summary:\n${(file.summary as string | undefined) ?? '(no summary)'}`
        return errorResult(text)
      }
    }

    if (contentType.startsWith('image/')) {
      // Return image bytes as an image tool-result entry
      try {
        const bytes = await fetchS3Bytes(s3Key)
        const format = contentType.split('/')[1] as 'png' | 'jpeg'
        return { entries: [{ kind: 'image', format, bytes }], isError: false }
      } catch {
        return textResult(`File: ${file.filename as string}\n\nSummary: ${(file.summary as string | undefined) ?? '(no summary)'}`)
      }
    }

    // Binary/unknown — return summary
    return textResult(`File: ${file.filename as string}\n\nBinary file — full content not available.\nSummary: ${(file.summary as string | undefined) ?? '(no summary)'}`)
  }

  return errorResult(`Unknown detail level: ${detail}`)
}

export async function executeProjectReadChatTool(
  input: Record<string, string>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { chatId: targetChatId, detail } = input
  if (!targetChatId || !ctx.projectId || !ctx.sub) {
    return errorResult('Missing chatId or project context')
  }

  // Reject reading the current chat (use the conversation directly)
  if (targetChatId === ctx.chatId) {
    return errorResult('Cannot read the current chat — it is already in your context.')
  }

  // Verify ownership: the chat must belong to this project
  const chat = await getChat(ctx.sub, targetChatId)
  if (!chat || chat.projectId !== ctx.projectId || chat.sensitive === true) {
    return errorResult(`Chat ${targetChatId} not found in this project`)
  }

  if (detail === 'summary' || !detail) {
    const summary = (chat.summary as string | undefined) ?? '(no summary yet)'
    return textResult(`Chat: ${chat.title as string}\n\nSummary: ${summary}`)
  }

  if (detail === 'full') {
    try {
      const rows = await listMessages(targetChatId)
      if (rows.length === 0) {
        return textResult(`Chat: ${chat.title as string}\n\n(no messages)`)
      }
      const typedRows = rows as unknown as TurnRow[]
      const path = buildActivePath(typedRows, (chat.activeLeafId as string | undefined) ?? null)
      const transcript = path
        .filter(r => r.role === 'user' || r.role === 'assistant')
        .slice(-TRANSCRIPT_TURNS_CAP)
        .map(r => {
          const text = r.blocks.filter(b => b.kind === 'text').map(b => b.text).filter(Boolean).join(' ')
          return `${r.role === 'user' ? 'User' : 'Assistant'}: ${text}`
        })
        .join('\n\n')
      const capped = capToolResultText(`Chat: ${chat.title as string}\n\n${transcript}`)
      return textResult(capped)
    } catch {
      return errorResult(`Could not load chat transcript for: ${chat.title as string}`)
    }
  }

  return errorResult(`Unknown detail level: ${detail}`)
}

function isTextLike(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType === 'application/octet-stream'
}

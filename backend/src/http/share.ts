import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getShare, getChat, listMessages } from '../lib/dynamo'
import { buildActivePath } from '../lib/tree'
import { groupTurnsToBubbles, signBubbleAttachments, filterSteps, renderMarkdown, renderHtml, type TurnRow } from '../lib/transcript'

// Public, UNAUTHENTICATED renderer for a shared chat — GET /s/{shareId}. No JWT: the route has
// authorization_type=NONE in terraform, and this file must never call subFromClaims. The
// unguessable ULID shareId is itself the capability — see backend/CLAUDE.md "Chat sharing".
//
// Server-rendered, self-contained response (no client-side API calls): a plain GET/curl returns
// readable HTML or Markdown immediately. Content negotiation, in priority order:
//   1. a trailing ".md" on the shareId path segment
//   2. ?format=md
//   3. Accept: text/markdown
// anything else -> text/html.

const html = (body: string, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  body,
})

const md = (body: string, status = 200): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' },
  body,
})

function notFound(wantsMarkdown: boolean): APIGatewayProxyResultV2 {
  return wantsMarkdown
    ? md('This shared link is invalid, revoked, or no longer exists.\n', 404)
    : html('<!doctype html><meta charset="utf-8"><title>Not found</title><p>This shared link is invalid, revoked, or no longer exists.</p>', 404)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const rawId = event.pathParameters?.shareId ?? ''
  const wantsMarkdownExt = rawId.toLowerCase().endsWith('.md')
  const shareId = wantsMarkdownExt ? rawId.slice(0, -3) : rawId
  const accept = event.headers?.accept ?? event.headers?.Accept ?? ''
  const wantsMarkdown = wantsMarkdownExt
    || event.queryStringParameters?.format === 'md'
    || accept.includes('text/markdown')

  if (!shareId) return notFound(wantsMarkdown)

  const share = await getShare(shareId)
  if (!share) return notFound(wantsMarkdown)

  const sub = share.sub as string
  const chatId = share.chatId as string
  const mode = share.mode as 'live' | 'snapshot'
  const includeThinking = share.includeThinking === true
  const includeTools = share.includeTools === true

  // Ownership gate: a deleted chat (or one that never belonged to this sub) 404s here with no
  // content leak, exactly like GET /api/chats/{chatId} does for the authenticated path.
  const chat = await getChat(sub, chatId)
  if (!chat) return notFound(wantsMarkdown)

  const rows = (await listMessages(chatId)) as unknown as TurnRow[]

  let pathRows: TurnRow[]
  if (mode === 'snapshot') {
    // Frozen at creation: only turns that were on the active path when the share was created.
    // New turns since then are invisible; turns since deleted simply aren't in `rows` anymore.
    const snapshotMsgIds = new Set((share.snapshotMsgIds as string[] | undefined) ?? [])
    pathRows = rows.filter(r => snapshotMsgIds.has(r.msgId))
  } else {
    // Live: always the chat's CURRENT active branch, so later edits/branches show up on reload.
    const activeLeafId = (chat.activeLeafId as string | undefined) ?? null
    pathRows = buildActivePath(rows, activeLeafId)
  }

  const { bubbles } = groupTurnsToBubbles(pathRows)
  await signBubbleAttachments(bubbles)
  const filtered = filterSteps(bubbles, { includeThinking, includeTools })
  const title = (chat.title as string | undefined) ?? 'Shared chat'

  console.log(JSON.stringify({ event: 'share_accessed', shareId, chatId, mode, format: wantsMarkdown ? 'md' : 'html' }))

  return wantsMarkdown
    ? md(renderMarkdown(filtered, { title }))
    : html(renderHtml(filtered, { title }))
}

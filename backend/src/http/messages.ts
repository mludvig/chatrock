import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getChat, listMessages } from '../lib/dynamo'
import { buildActivePath } from '../lib/tree'
import { subFromClaims } from '../lib/auth'
import { groupTurnsToBubbles, signBubbleAttachments, type RawBubble, type TurnRow } from '../lib/transcript'

// Default page size for GET /messages — the most recent DEFAULT_PAGE_LIMIT bubbles on the
// active path load (and get their attachments signed) up front; older ones are fetched via
// ?before=<oldestMsgId> as the user scrolls up. Keeps signing cost bounded to what's on
// screen instead of growing with total chat length.
const DEFAULT_PAGE_LIMIT = 40

const ok = (body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const err = (status: number, msg: string): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: msg }),
})

// External shape sent to the client (includes sibling metadata, on top of RawBubble from
// lib/transcript.ts's groupTurnsToBubbles)
interface DisplayBubble extends RawBubble {
  siblingIndex: number
  siblingCount: number
  siblings: string[]
}

interface MessagesResponse {
  bubbles: DisplayBubble[]
  conversationUsage: ReturnType<typeof groupTurnsToBubbles>['conversationUsage']
  hasMore: boolean
  oldestMsgId: string | null
}

// ── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const sub = subFromClaims(event.requestContext.authorizer.jwt.claims)
  const chatId = event.pathParameters?.chatId
  if (!chatId) return err(400, 'Missing chatId')

  const chat = await getChat(sub, chatId)
  if (!chat) return err(404, 'Not found')

  console.log(JSON.stringify({ event: 'messages_accessed', sub, chatId }))
  const items = await listMessages(chatId)
  // Walk the active branch only — for a single-branch chat this is identical to
  // the flat array; for a branched chat it filters to the active root→leaf path.
  const activeLeafId = (chat.activeLeafId as string | undefined) ?? null
  const activePath = buildActivePath(items as unknown as TurnRow[], activeLeafId)
  // groupTurnsToBubbles is pure/sync (no signing) — cheap to call on the full history.
  const rawResponse = groupTurnsToBubbles(activePath)

  // Compute sibling metadata by grouping ALL bubbles (full row set) by parentId. Reusing
  // groupTurnsToBubbles ensures only true bubble-start nodes are counted — toolResult rows
  // fold into their assistant bubble and never appear as siblings. Never signed — this set's
  // attachment content is discarded, only msgId/parentId are used.
  const allBubbles = groupTurnsToBubbles(items as unknown as TurnRow[]).bubbles
  const siblingsByParent = new Map<string | null, string[]>()
  for (const b of allBubbles) {
    const key = b.parentId ?? null
    const list = siblingsByParent.get(key) ?? []
    list.push(b.msgId)
    siblingsByParent.set(key, list)
  }

  // Paginate: most recent DEFAULT_PAGE_LIMIT bubbles by default, or the LIMIT bubbles
  // immediately before `before` (an older page, scrolled up to). Signing (the expensive
  // I/O) runs only on the page being returned, not the whole active path.
  const allActiveBubbles = rawResponse.bubbles
  const limitParam = Number(event.queryStringParameters?.limit)
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_PAGE_LIMIT
  const before = event.queryStringParameters?.before
  const endIndex = before
    ? allActiveBubbles.findIndex(b => b.msgId === before)
    : allActiveBubbles.length
  const startIndex = endIndex <= 0 ? 0 : Math.max(0, endIndex - limit)
  const pageBubbles = endIndex <= 0 ? [] : allActiveBubbles.slice(startIndex, endIndex)
  const hasMore = startIndex > 0
  const oldestMsgId = pageBubbles[0]?.msgId ?? null

  await signBubbleAttachments(pageBubbles)

  const enrichedBubbles: DisplayBubble[] = pageBubbles.map(b => {
    const siblings = siblingsByParent.get(b.parentId ?? null) ?? [b.msgId]
    const siblingIndex = siblings.indexOf(b.msgId) + 1  // 1-based
    return { ...b, siblings, siblingIndex, siblingCount: siblings.length }
  })

  const response: MessagesResponse = {
    bubbles: enrichedBubbles,
    conversationUsage: rawResponse.conversationUsage,
    hasMore,
    oldestMsgId,
  }
  return ok(response)
}

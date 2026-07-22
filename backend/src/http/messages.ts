import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getChat, listMessages } from '../lib/dynamo'
import { buildActivePath } from '../lib/tree'
import { subFromClaims } from '../lib/auth'
import { groupTurnsToBubbles, type RawBubble, type TurnRow } from '../lib/transcript'

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
  const rawResponse = await groupTurnsToBubbles(activePath)

  // Compute sibling metadata by grouping ALL bubbles (full row set) by parentId.
  // Reusing groupTurnsToBubbles ensures only true bubble-start nodes are counted —
  // toolResult rows fold into their assistant bubble and never appear as siblings.
  const allBubbles = (await groupTurnsToBubbles(items as unknown as TurnRow[])).bubbles
  const siblingsByParent = new Map<string | null, string[]>()
  for (const b of allBubbles) {
    const key = b.parentId ?? null
    const list = siblingsByParent.get(key) ?? []
    list.push(b.msgId)
    siblingsByParent.set(key, list)
  }

  const enrichedBubbles: DisplayBubble[] = rawResponse.bubbles.map(b => {
    const siblings = siblingsByParent.get(b.parentId ?? null) ?? [b.msgId]
    const siblingIndex = siblings.indexOf(b.msgId) + 1  // 1-based
    return { ...b, siblings, siblingIndex, siblingCount: siblings.length }
  })

  return ok({ ...rawResponse, bubbles: enrichedBubbles })
}

import type { Message } from '../api/http'

// Messages sent while a turn is running wait on the server until its next tool boundary,
// where it writes each one into the transcript as an ordinary user turn. Until then the
// client shows them after the live answer. See docs/adr/0059-queued-user-messages-steer-a-running-turn.md.

export function queuedBubble(content: string, sentAt: string, msgId: string = crypto.randomUUID()): Message {
  return { msgId, role: 'user', steps: content ? [{ kind: 'text', text: content }] : [], model: '', createdAt: sentAt }
}

const textOf = (m: Message) => m.steps.map(s => (s.kind === 'text' ? s.text : '')).join('')

// The server announced one queued message as written into the transcript: lift it out of
// the queue (keeping its attachments) under the id it was persisted with. A message sent
// from another device isn't in this client's queue, so it's built from the frame instead.
export function takeInjected(queue: Message[], frame: { msgId: string; parentId: string | null; content: string }): { bubble: Message; rest: Message[] } {
  const idx = queue.findIndex(m => textOf(m) === frame.content)
  const base = idx >= 0 ? queue[idx] : queuedBubble(frame.content, new Date().toISOString())
  return {
    bubble: { ...base, msgId: frame.msgId, parentId: frame.parentId },
    rest: idx >= 0 ? [...queue.slice(0, idx), ...queue.slice(idx + 1)] : queue,
  }
}

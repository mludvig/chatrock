import { describe, expect, it } from 'vitest'
import { queuedBubble, takeInjected } from './queuedMessages'

describe('takeInjected', () => {
  it('lifts the matching queued message out under the persisted id, keeping the rest in order', () => {
    const queue = [queuedBubble('first', '2026-10-09T00:00:00Z', 'a'), queuedBubble('second', '2026-10-09T00:00:01Z', 'b')]
    const { bubble, rest } = takeInjected(queue, { msgId: 'm1', parentId: 'p1', content: 'second' })
    expect(bubble).toMatchObject({ msgId: 'm1', parentId: 'p1', role: 'user', steps: [{ kind: 'text', text: 'second' }] })
    expect(rest.map(m => m.msgId)).toEqual(['a'])
  })

  it('builds the bubble from the frame for a message this client never queued', () => {
    const queue = [queuedBubble('mine', '2026-10-09T00:00:00Z', 'a')]
    const { bubble, rest } = takeInjected(queue, { msgId: 'm2', parentId: 'p2', content: 'from another device' })
    expect(bubble).toMatchObject({ msgId: 'm2', parentId: 'p2', steps: [{ kind: 'text', text: 'from another device' }] })
    expect(rest).toBe(queue)
  })
})

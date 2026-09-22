import { describe, expect, it } from 'vitest'
import { sortByRecent } from './sort'

describe('sortByRecent', () => {
  it('orders by lastMessageAt, ignoring updatedAt so metadata edits never reorder the list', () => {
    const chats = [
      { id: 'old-msg-recent-edit', createdAt: '2026-08-01T00:00:00Z', lastMessageAt: '2026-08-03T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' },
      { id: 'recent-msg', createdAt: '2026-09-01T00:00:00Z', lastMessageAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' },
    ]
    expect(sortByRecent(chats).map(c => c.id)).toEqual(['recent-msg', 'old-msg-recent-edit'])
  })

  it('falls back to createdAt for a chat with no message yet', () => {
    const chats = [
      { id: 'messaged', createdAt: '2026-09-01T00:00:00Z', lastMessageAt: '2026-09-05T00:00:00Z' },
      { id: 'brand-new', createdAt: '2026-09-06T00:00:00Z' },
    ]
    expect(sortByRecent(chats).map(c => c.id)).toEqual(['brand-new', 'messaged'])
  })
})

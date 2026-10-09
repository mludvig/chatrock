import { describe, expect, it } from 'vitest'
import { mergeFetchedChats } from './chatList'

const ids = (chats: { chatId: string }[]) => chats.map(c => c.chatId)

describe('mergeFetchedChats', () => {
  it('keeps a chat created locally while the list request was in flight', () => {
    const fetched = [{ chatId: 'a' }, { chatId: 'b' }]
    const current = [{ chatId: 'new' }, { chatId: 'a' }, { chatId: 'b' }]
    expect(ids(mergeFetchedChats(fetched, current, new Set(['a', 'b'])))).toEqual(['new', 'a', 'b'])
  })

  it('does not resurrect a chat deleted locally while the request was in flight', () => {
    const fetched = [{ chatId: 'a' }, { chatId: 'b' }]
    const current = [{ chatId: 'b' }]
    expect(ids(mergeFetchedChats(fetched, current, new Set(['a', 'b'])))).toEqual(['b'])
  })

  it('drops a chat the server no longer has if it was already known when the request began', () => {
    const fetched = [{ chatId: 'b' }]
    const current = [{ chatId: 'a' }, { chatId: 'b' }]
    expect(ids(mergeFetchedChats(fetched, current, new Set(['a', 'b'])))).toEqual(['b'])
  })

  it('takes the server copy of a chat present in both', () => {
    const fetched = [{ chatId: 'a', title: 'server' }]
    const current = [{ chatId: 'a', title: 'stale' }]
    expect(mergeFetchedChats(fetched, current, new Set(['a']))).toEqual([{ chatId: 'a', title: 'server' }])
  })

  it('on first load (empty store) is just the fetched list', () => {
    const fetched = [{ chatId: 'a' }, { chatId: 'b' }]
    expect(ids(mergeFetchedChats(fetched, [], new Set()))).toEqual(['a', 'b'])
  })
})

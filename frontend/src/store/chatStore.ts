import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Chat, Message, Model } from '../api/http'

interface StreamingMsg {
  role: 'assistant'
  content: string
  streaming: true
}

interface ChatState {
  chats: Chat[]
  activeChatId: string | null
  messages: Message[]
  streamingMsg: StreamingMsg | null
  models: Model[]
  loading: boolean
  sending: boolean
  lastModel: string

  setChats: (chats: Chat[]) => void
  addChat: (chat: Chat) => void
  removeChat: (chatId: string) => void
  renameChat: (chatId: string, title: string) => void
  updateChatSystemPrompt: (chatId: string, systemPrompt: string) => void
  setActiveChat: (chatId: string | null) => void
  setMessages: (messages: Message[]) => void
  appendDelta: (text: string) => void
  finalizeStream: (content: string) => void
  clearStream: () => void
  setModels: (models: Model[]) => void
  setLoading: (v: boolean) => void
  setSending: (v: boolean) => void
  setLastModel: (modelId: string) => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      chats: [],
      activeChatId: null,
      messages: [],
      streamingMsg: null,
      models: [],
      loading: false,
      sending: false,
      lastModel: '',

      setChats: (chats) => set({ chats }),
      addChat: (chat) => set((s) => ({ chats: [chat, ...s.chats] })),
      removeChat: (chatId) => set((s) => ({
        chats: s.chats.filter(c => c.chatId !== chatId),
        activeChatId: s.activeChatId === chatId ? null : s.activeChatId,
        messages: s.activeChatId === chatId ? [] : s.messages,
      })),
      renameChat: (chatId, title) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, title } : c),
      })),
      updateChatSystemPrompt: (chatId, systemPrompt) => set((s) => ({
        chats: s.chats.map(c => c.chatId === chatId ? { ...c, systemPrompt } : c),
      })),
      setActiveChat: (chatId) => set({ activeChatId: chatId, messages: [], streamingMsg: null }),
      setMessages: (messages) => set({ messages }),
      appendDelta: (text) => set((s) => ({
        streamingMsg: {
          role: 'assistant',
          content: (s.streamingMsg?.content ?? '') + text,
          streaming: true,
        },
      })),
      finalizeStream: (content) => set((s) => ({
        messages: [
          ...s.messages,
          { msgId: crypto.randomUUID(), role: 'assistant', content, model: '', createdAt: new Date().toISOString() },
        ],
        streamingMsg: null,
      })),
      clearStream: () => set({ streamingMsg: null }),
      setModels: (models) => set({ models }),
      setLoading: (loading) => set({ loading }),
      setSending: (sending) => set({ sending }),
      setLastModel: (lastModel) => set({ lastModel }),
    }),
    {
      name: 'chatrock-store',
      partialize: (s) => ({ lastModel: s.lastModel }),
    }
  )
)

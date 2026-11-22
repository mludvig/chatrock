const mockSend = jest.fn()
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockSend })),
  InvokeWebSearchCommand: jest.fn(function (this: { input: unknown }, input: unknown) { this.input = input }),
}))

import { invokeWebSearch } from '../../../src/lib/agentcore/search'

beforeEach(() => mockSend.mockReset())

test('uses the direct managed API with a bounded query and five results', async () => {
  const results = [{ title: 'Example', url: 'https://example.com', text: 'Snippet', publishedAt: new Date() }]
  mockSend.mockResolvedValue({ results })
  expect(await invokeWebSearch('x'.repeat(250))).toEqual(results)
  expect(mockSend.mock.calls[0][0].input).toEqual({
    webSearchId: 'web-search.v1', searchQuery: 'x'.repeat(200), maxResults: 5,
  })
})

test('normalizes an omitted result list and propagates API errors for fallback', async () => {
  mockSend.mockResolvedValueOnce({})
  expect(await invokeWebSearch('hello')).toEqual([])
  mockSend.mockRejectedValueOnce(new Error('AccessDenied'))
  await expect(invokeWebSearch('hello')).rejects.toThrow('AccessDenied')
})

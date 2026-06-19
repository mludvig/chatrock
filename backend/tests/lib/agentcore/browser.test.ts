// Mocks for every external boundary browser.ts touches — no real AWS calls, no real MCP
// server/transport, no real browser. Mirrors the wholesale-module-mock pattern used for
// ./gateway.ts elsewhere in this suite (no gateway.test.ts exists either — both are thin
// orchestration modules exercised indirectly via their consumers, except this one also
// gets its own direct test since it owns a billed AWS session that must always be stopped).

const mockSend = jest.fn()
const mockStartCtor = jest.fn((input: unknown) => ({ __type: 'start', input }))
const mockStopCtor = jest.fn((input: unknown) => ({ __type: 'stop', input }))

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  StartBrowserSessionCommand: mockStartCtor,
  StopBrowserSessionCommand: mockStopCtor,
}))

jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }), // pragma: allowlist secret
}))

const mockCreateConnection = jest.fn()
jest.mock('@playwright/mcp', () => ({
  createConnection: mockCreateConnection,
}))

jest.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: { createLinkedPair: jest.fn(() => [{}, {}]) },
}))

const mockCallTool = jest.fn()
const mockClientConnect = jest.fn()
const mockClientClose = jest.fn().mockResolvedValue(undefined)
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockClientConnect,
    callTool: mockCallTool,
    close: mockClientClose,
  })),
}))

import { runBrowserSteps } from '../../../src/lib/agentcore/browser'

const STREAM_ENDPOINT = 'wss://bedrock-agentcore.ap-southeast-2.amazonaws.com/browser-streams/aws.browser.v1/sessions/sess-1/automation'

function mockStartSession() {
  mockSend.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'start') {
      return {
        sessionId: 'sess-1',
        streams: { automationStream: { streamEndpoint: STREAM_ENDPOINT, streamStatus: 'ENABLED' } },
      }
    }
    return { sessionId: 'sess-1' }
  })
  mockCreateConnection.mockResolvedValue({ connect: jest.fn() })
}

beforeEach(() => {
  jest.clearAllMocks()
})

test('happy path: runs steps in order, aggregates text and image content', async () => {
  mockStartSession()
  mockCallTool
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Navigated to https://example.com' }], isError: false })
    .mockResolvedValueOnce({ content: [{ type: 'image', data: Buffer.from('fakepng').toString('base64'), mimeType: 'image/png' }], isError: false })

  const result = await runBrowserSteps([
    { tool: 'browser_navigate', params: { url: 'https://example.com' } },
    { tool: 'browser_take_screenshot', params: { type: 'png' } },
  ])

  expect(result.isError).toBe(false)
  expect(result.results).toHaveLength(2)
  expect(result.results[0]).toMatchObject({ tool: 'browser_navigate', ok: true, text: ['Navigated to https://example.com'], images: [] })
  expect(result.results[1].ok).toBe(true)
  expect(result.results[1].images).toEqual([{ format: 'png', bytes: Buffer.from('fakepng') }])

  expect(mockStopCtor).toHaveBeenCalledWith({ browserIdentifier: 'aws.browser.v1', sessionId: 'sess-1' })
})

test('mid-list step failure stops execution but keeps earlier results', async () => {
  mockStartSession()
  mockCallTool
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], isError: false })
    .mockRejectedValueOnce(new Error('selector not found'))

  const result = await runBrowserSteps([
    { tool: 'browser_navigate', params: { url: 'https://example.com' } },
    { tool: 'browser_click', params: { target: 'e3' } },
    { tool: 'browser_snapshot', params: {} },
  ])

  expect(result.isError).toBe(true)
  expect(result.results).toHaveLength(2) // third step never runs
  expect(result.results[0].ok).toBe(true)
  expect(result.results[1].ok).toBe(false)
  expect(result.results[1].error).toMatch(/selector not found/)
  expect(mockCallTool).toHaveBeenCalledTimes(2)
})

test('StopBrowserSession is called even when the session/connection setup throws', async () => {
  mockSend.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'start') {
      return { sessionId: 'sess-1', streams: { automationStream: { streamEndpoint: STREAM_ENDPOINT, streamStatus: 'ENABLED' } } }
    }
    return { sessionId: 'sess-1' }
  })
  mockCreateConnection.mockRejectedValue(new Error('cdp connect failed'))

  const result = await runBrowserSteps([{ tool: 'browser_navigate', params: { url: 'https://example.com' } }])

  expect(result.isError).toBe(true)
  expect(mockStopCtor).toHaveBeenCalledWith({ browserIdentifier: 'aws.browser.v1', sessionId: 'sess-1' })
})

test('throws when StartBrowserSession does not return a session id or stream endpoint', async () => {
  mockSend.mockResolvedValue({})
  await expect(runBrowserSteps([{ tool: 'browser_navigate', params: { url: 'https://example.com' } }]))
    .rejects.toThrow(/StartBrowserSession/)
})

test('SigV4-signs the CDP connection headers passed to createConnection', async () => {
  mockStartSession()
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false })

  await runBrowserSteps([{ tool: 'browser_navigate', params: { url: 'https://example.com' } }])

  expect(mockCreateConnection).toHaveBeenCalledTimes(1)
  const config = mockCreateConnection.mock.calls[0][0]
  expect(config.browser.cdpEndpoint).toBe(STREAM_ENDPOINT)
  const headerKeys = Object.keys(config.browser.cdpHeaders).map(k => k.toLowerCase())
  expect(headerKeys).toContain('authorization')
  expect(headerKeys).toContain('x-amz-date')
  expect(headerKeys).toContain('host')
})

test('restricts capabilities to the core/navigation/input/tabs subset', async () => {
  mockStartSession()
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false })

  await runBrowserSteps([{ tool: 'browser_navigate', params: { url: 'https://example.com' } }])

  const config = mockCreateConnection.mock.calls[0][0]
  expect(config.capabilities).toEqual(['core', 'core-navigation', 'core-input', 'core-tabs'])
})

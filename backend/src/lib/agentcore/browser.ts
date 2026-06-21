// AgentCore Browser — a managed, isolated Chromium session driven over the Chrome DevTools
// Protocol. Unlike Web Search (an MCP Gateway target, see ./gateway.ts), Browser is a direct
// data-plane session API: StartBrowserSession -> SigV4-signed WebSocket (CDP) -> drive the
// page -> StopBrowserSession. AWS ships no Bedrock tool spec or MCP tool catalogue for it.
//
// Rather than hand-roll page automation, this module embeds the official `@playwright/mcp`
// package (Apache-2.0) and points it at the AgentCore session's CDP endpoint via its
// `cdpEndpoint`/`cdpHeaders` config — getting the real, battle-tested tool implementations
// (accessibility-tree snapshots + ref-based targeting, console capture, screenshots) for the
// cost of the AgentCore session lifecycle + SigV4 WS signing, neither of which `@playwright/mcp`
// knows about. We drive the embedded server with our own in-process MCP client over an
// InMemoryTransport pair — the same `@modelcontextprotocol/sdk` already used by ./gateway.ts.
//
// This module is a pure mechanical executor: it knows which `tool`/`params` to call and
// returns plain content, with zero opinion on which tool names are allowed, Bedrock content-
// block shapes, or S3/CloudFront — those live in ../tools.ts and ../bedrock.ts.

import { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore'
import { createConnection } from '@playwright/mcp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

const AGENTCORE_SERVICE = 'bedrock-agentcore'
const BROWSER_IDENTIFIER = 'aws.browser.v1'
const SESSION_TIMEOUT_SECONDS = 120

function getRegion(): string {
  return process.env.AWS_REGION ?? 'ap-southeast-2'
}

const agentCoreClient = new BedrockAgentCoreClient({ region: getRegion() })

const signer = new SignatureV4({
  service: AGENTCORE_SERVICE,
  region: getRegion(),
  credentials: defaultProvider(),
  sha256: Sha256,
})

// SigV4-sign the WebSocket-upgrade GET request for the automation stream. The signature
// computation doesn't depend on scheme (wss vs https), only method/host/path/query/headers.
async function signWsHeaders(wsUrl: string): Promise<Record<string, string>> {
  const u = new URL(wsUrl)
  const request = new HttpRequest({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: { host: u.host },
  })
  const signed = await signer.sign(request)
  return signed.headers
}

export interface BrowserStep {
  tool: string
  params: Record<string, unknown>
}

export interface BrowserStepResult {
  tool: string
  ok: boolean
  text: string[]
  images: Array<{ format: string; bytes: Uint8Array }>
  error?: string
}

export interface RunBrowserStepsResult {
  results: BrowserStepResult[]
  isError: boolean
}

interface MCPContentItem {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

interface MCPCallToolResult {
  content?: MCPContentItem[]
  isError?: boolean
}

export async function runBrowserSteps(steps: BrowserStep[]): Promise<RunBrowserStepsResult> {
  const started = await agentCoreClient.send(new StartBrowserSessionCommand({
    browserIdentifier: BROWSER_IDENTIFIER,
    name: `chatrock-${Date.now()}`,
    sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
  }))

  const sessionId = started.sessionId
  const streamEndpoint = started.streams?.automationStream?.streamEndpoint
  if (!sessionId || !streamEndpoint) {
    throw new Error('StartBrowserSession did not return a session id or automation stream endpoint')
  }

  const results: BrowserStepResult[] = []
  let isError = false

  try {
    const cdpHeaders = await signWsHeaders(streamEndpoint)

    const server = await createConnection({
      browser: { cdpEndpoint: streamEndpoint, cdpHeaders, cdpTimeout: 30_000 },
      capabilities: ['core', 'core-navigation', 'core-input', 'core-tabs'],
      imageResponses: 'allow',
      outputDir: '/tmp',
      console: { level: 'info' },
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'chatrock-backend', version: '1.0.0' })
    await client.connect(clientTransport)

    try {
      for (const step of steps) {
        const text: string[] = []
        const images: Array<{ format: string; bytes: Uint8Array }> = []
        let stepOk = true
        let stepError: string | undefined

        try {
          const result = await client.callTool({ name: step.tool, arguments: step.params }) as unknown as MCPCallToolResult
          for (const item of result.content ?? []) {
            if (item.type === 'text' && item.text) text.push(item.text)
            if (item.type === 'image' && item.data) {
              images.push({
                format: (item.mimeType ?? 'image/png').split('/')[1] ?? 'png',
                bytes: Buffer.from(item.data, 'base64'),
              })
            }
          }
          if (result.isError) {
            stepOk = false
            stepError = text.join('\n') || 'Tool reported an error'
          }
        } catch (err) {
          stepOk = false
          stepError = err instanceof Error ? err.message : String(err)
        }

        results.push({ tool: step.tool, ok: stepOk, text, images, error: stepError })

        if (!stepOk) {
          isError = true
          break
        }
      }
    } finally {
      await client.close().catch(() => {})
    }
  } catch (err) {
    isError = true
    results.push({
      tool: '_session',
      ok: false,
      text: [],
      images: [],
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    await agentCoreClient.send(new StopBrowserSessionCommand({
      browserIdentifier: BROWSER_IDENTIFIER,
      sessionId,
    })).catch(() => {})
  }

  return { results, isError }
}

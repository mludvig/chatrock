// Minimal MCP (Model Context Protocol) client for Amazon Bedrock AgentCore Gateway targets.
//
// AgentCore exposes managed capabilities (Web Search today; Code Interpreter is a likely
// future addition) as MCP tools behind a Gateway endpoint. Calls are authenticated with
// plain SigV4 (inbound auth type AWS_IAM on the gateway) using the Lambda's own execution
// role — no separate OAuth/Cognito machine-to-machine flow needed.
//
// This module is the generic seam: `callGatewayTool` knows how to open an MCP session
// against the configured gateway and invoke a named tool. Provider-specific callers (e.g.
// `agentcoreSearch` in ../tools.ts) map the MCP result shape into whatever contract they need.
// A future Code Interpreter integration would add its own thin wrapper here, reusing
// `callGatewayTool` unchanged.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

const AGENTCORE_SERVICE = 'bedrock-agentcore'

function getRegion(): string {
  return process.env.AGENTCORE_REGION ?? 'us-east-1'
}

function getGatewayUrl(): string {
  const url = process.env.AGENTCORE_GATEWAY_URL
  if (!url) throw new Error('AGENTCORE_GATEWAY_URL is not configured')
  return url
}

// One signer per Lambda execution context; region is fixed at module load (AgentCore
// gateways are region-pinned resources, unlike the cross-region Bedrock inference profiles).
const signer = new SignatureV4({
  service: AGENTCORE_SERVICE,
  region: getRegion(),
  credentials: defaultProvider(),
  sha256: Sha256,
})

// SigV4-signs every request the MCP transport makes (POST for JSON-RPC calls, GET to open
// the SSE stream, DELETE to terminate the session) before delegating to the real fetch.
const signedFetch: FetchLike = async (url, init = {}) => {
  const u = new URL(url)
  const headers: Record<string, string> = { host: u.host }
  if (init.headers) {
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v
  }

  const body = typeof init.body === 'string' ? init.body : undefined

  const request = new HttpRequest({
    method: init.method ?? 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers,
    body,
  })

  const signed = await signer.sign(request)

  return fetch(u, {
    method: signed.method,
    headers: signed.headers as HeadersInit,
    body: signed.body as BodyInit | undefined,
  })
}

export interface GatewayToolResult {
  isError: boolean
  text: string
}

type ListedTool = { name: string }

// The SDK's callTool() return type is a deeply nested union (modern content[] shape vs.
// a legacy toolResult shape) that doesn't narrow cleanly through index signatures — model
// only the shape the Web Search connector actually returns and cast at the boundary.
interface MCPCallToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

// Gateway connector targets may expose tools under a target-qualified name
// (observed pattern: `<targetName>___<ToolName>`). Try the bare name first since that's
// what the Web Search connector docs show, then fall back to discovery via tools/list.
async function callToolWithFallback(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<MCPCallToolResult> {
  try {
    return await client.callTool({ name: toolName, arguments: args }) as unknown as MCPCallToolResult
  } catch (err) {
    const { tools } = await client.listTools()
    const match = (tools as ListedTool[]).find(
      t => t.name === toolName || t.name.toLowerCase().endsWith(toolName.toLowerCase()),
    )
    if (!match) throw err
    return await client.callTool({ name: match.name, arguments: args }) as unknown as MCPCallToolResult
  }
}

// Opens a fresh MCP session against the configured gateway, calls one tool, and tears the
// session down. AgentCore Gateway sessions are cheap to (re-)establish and Lambda
// invocations are short-lived, so there is no cross-invocation session caching here.
export async function callGatewayTool(toolName: string, args: Record<string, unknown>): Promise<GatewayToolResult> {
  const transport = new StreamableHTTPClientTransport(new URL(getGatewayUrl()), { fetch: signedFetch })
  const client = new Client({ name: 'chatrock-backend', version: '1.0.0' })
  await client.connect(transport)
  try {
    const result = await callToolWithFallback(client, toolName, args)
    const textBlock = result.content.find(c => c.type === 'text')
    return { isError: !!result.isError, text: textBlock?.text ?? '' }
  } finally {
    await client.close()
  }
}

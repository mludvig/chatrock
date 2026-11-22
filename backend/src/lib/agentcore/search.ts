import { BedrockAgentCoreClient, InvokeWebSearchCommand } from '@aws-sdk/client-bedrock-agentcore'

// Uses the deployment's AWS region and the Lambda execution role directly.
// See docs/adr/0068-direct-web-search-with-provider-escalation.md.
const client = new BedrockAgentCoreClient({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
})

export async function invokeWebSearch(query: string) {
  const response = await client.send(new InvokeWebSearchCommand({
    webSearchId: 'web-search.v1',
    searchQuery: query.slice(0, 200),
    maxResults: 5,
  }))
  return response.results ?? []
}

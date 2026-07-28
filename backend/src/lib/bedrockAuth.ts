import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

/**
 * Cross-account Bedrock auth: when BEDROCK_BEARER_TOKEN_SSM names an SSM parameter holding a
 * real Bedrock API key (docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html), setting
 * AWS_BEARER_TOKEN_BEDROCK in the environment makes the Bedrock SDK clients use it automatically
 * (aws-sdk/core's httpAuthSchemeProvider prefers bearer auth over sigv4 whenever that env var is
 * present, checked lazily per-request — not at client construction). This lets the app run in one
 * AWS account while billing/quota for Bedrock calls lands in another (e.g. one with Bedrock
 * credits). Falls back to the Lambda's own IAM role (native same-account sigv4 auth) whenever the
 * parameter is absent, empty, or holds the unset sentinel.
 */

const TOKEN_PARAM = process.env.BEDROCK_BEARER_TOKEN_SSM ?? ''
const UNSET_SENTINEL = 'UNSET'

function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length)
  return `${token.slice(0, 4)}...${token.slice(-3)}`
}

async function loadBearerToken(): Promise<void> {
  if (!TOKEN_PARAM) {
    console.log(JSON.stringify({ event: 'bedrock_auth', mode: 'iam', reason: 'ssm_param_not_configured' }))
    return
  }
  try {
    const ssm = new SSMClient({})
    const res = await ssm.send(new GetParameterCommand({ Name: TOKEN_PARAM, WithDecryption: true }))
    const value = res.Parameter?.Value?.trim()
    if (!value || value === UNSET_SENTINEL) {
      console.log(JSON.stringify({ event: 'bedrock_auth', mode: 'iam', reason: 'token_not_set' }))
      return
    }
    process.env.AWS_BEARER_TOKEN_BEDROCK = value
    console.log(JSON.stringify({ event: 'bedrock_auth', mode: 'bearer_token', token: maskToken(value) }))
  } catch (err) {
    console.log(JSON.stringify({ event: 'bedrock_auth', mode: 'iam', reason: 'ssm_read_failed', error: String(err) }))
  }
}

let loaded = false
let loadPromise: Promise<void> | null = null

/**
 * Ensure AWS_BEARER_TOKEN_BEDROCK is populated (or confirmed absent) before the first Bedrock
 * SDK call in this Lambda execution environment. Memoized — the SSM read happens at most once
 * per container.
 */
export function ensureBedrockAuth(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (!loadPromise) loadPromise = loadBearerToken().then(() => { loaded = true })
  return loadPromise
}

/** Region for Bedrock calls specifically — independent of the Lambda's own AWS_REGION so the
 * bearer-token account's Bedrock calls can target a different region than the rest of the app. */
export function bedrockRegion(): string {
  return process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-southeast-2'
}

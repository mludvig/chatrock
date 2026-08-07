# 2. Tune the WS execution-error alarm instead of switching to async Lambda invocation

## Status

Accepted

## Context

`chatrock-ws-api-execution-error-prod` (CloudWatch alarm on `ExecutionError`, the WebSocket-API equivalent of an HTTP `5xx`) fired on 2026-08-02. Cross-referencing the WS API Gateway access logs (`/aws/apigateway/chatrock-ws-prod`, a `504` on the `sendMessage` route) against the `ws_send_message` Lambda's own application logs for the same request showed the Lambda kept running past 29s and finished streaming a complete answer over `postToConnection` — the request the client actually cared about succeeded.

Root cause: `sendMessage`'s WS route (`terraform/apigw_ws.tf`) uses `AWS_PROXY` integration, which is always a synchronous (`RequestResponse`) Lambda invoke. API Gateway WebSocket route integration timeout is hard-capped at 29 seconds — non-configurable, and applies to any integration type, not just `AWS_PROXY`. A turn with several sequential tool calls (e.g. three `web_search` calls) can exceed that ceiling even though nothing is actually broken: `postToConnection` frames are a separate channel, unaffected by APIGW's synchronous wait on the Lambda invoke's return value.

Alternatives considered:

1. **Switch to true async invocation.** Requires changing the integration from `AWS_PROXY` to plain `AWS` (non-proxy) with an `integration.request.header.X-Amz-Invocation-Type = 'Event'` request parameter — which needs hand-written VTL request/response mapping templates and loses `AWS_PROXY`'s automatic payload passthrough. Removes the 29s ceiling entirely, but is a much larger and riskier change than the actual problem (a cosmetic alarm) warrants.
2. **Send periodic WS "noop" frames while waiting.** Doesn't help — the 29s timer is API Gateway waiting on the Lambda invoke's own return value, a completely different channel from `postToConnection` frames the client receives.
3. **Parallelize the tool-use round** so multi-tool turns finish faster more often. Reduces how often the ceiling is hit, but doesn't remove it, and is really a separate, independent improvement (see the tool-execution-loop work referenced from `backend/src/lib/llm/loop.ts`).
4. **Tune the alarm.** Raise the threshold so a single long turn doesn't page, but a sustained burst still does.

## Decision

Chose option 4. The 29s ceiling is a hard, non-configurable AWS platform limit; the WS route's own synchronous-invoke outcome is genuinely decoupled from whether the client's request succeeded. Given that, the risk/effort of the async-invocation rearchitecture isn't justified purely to silence a cosmetic alarm. `terraform/alarms.tf`'s `ws_api_execution_error` alarm: `threshold` 1 → 5, `period` unchanged at 300s, `GreaterThanOrEqualToThreshold` — requires a sustained burst (5+ in 5 minutes) rather than one-off timeouts.

## Consequences

- A single long tool-use turn no longer pages; only a sustained burst of `ExecutionError`s does, which still catches a genuine integration break (bad deploy, auth failure, systemic Bedrock outage).
- The underlying cosmetic-504 behavior remains — WS access logs will keep showing occasional `504`s on `sendMessage` for long turns. Expected, not actionable.
- If Chatrock later needs true fire-and-forget WS sends (e.g. long tool chains becoming the norm rather than the exception), the async `AWS`-integration + VTL redesign from option 1 remains the correct fix and should get its own ADR when undertaken.

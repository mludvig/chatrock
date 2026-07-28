# ── Alerting ─────────────────────────────────────────────────────────────────
# Every alarm below publishes to this one SNS topic. Subscribe to it via var.alarm_email
# (terraform.tfvars, gitignored) — AWS emails a confirmation link that must be clicked before
# notifications actually flow. Leaving alarm_email empty still creates working alarms (visible
# in the CloudWatch console/API), just with nowhere to notify until something subscribes.
resource "aws_sns_topic" "alerts" {
  name = "chatrock-alerts-${var.env}"
  tags = { Env = var.env }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # Every Lambda this app deploys — fans out the generic per-function alarms below without a
  # repeated aws_cloudwatch_metric_alarm block per function.
  lambda_functions = {
    http_chats          = aws_lambda_function.http_chats
    http_messages       = aws_lambda_function.http_messages
    http_share          = aws_lambda_function.http_share
    http_models         = aws_lambda_function.http_models
    http_preferences    = aws_lambda_function.http_preferences
    http_memory         = aws_lambda_function.http_memory
    http_projects       = aws_lambda_function.http_projects
    ws_authorizer       = aws_lambda_function.ws_authorizer
    ws_connect          = aws_lambda_function.ws_connect
    ws_disconnect       = aws_lambda_function.ws_disconnect
    ws_send_message     = aws_lambda_function.ws_send_message
    ws_cancel_message   = aws_lambda_function.ws_cancel_message
    stream_chat_cleanup = aws_lambda_function.stream_chat_cleanup
  }
}

# ── Lambda: unhandled errors ────────────────────────────────────────────────
# One per function rather than an aggregate — an aggregate would tell you *something* broke
# without saying what, and these are cheap ($0.10/mo each per current CloudWatch pricing).
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_functions

  alarm_name          = "chatrock-${each.key}-errors-${var.env}"
  alarm_description   = "${each.key} Lambda raised an unhandled error"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# Throttling matters most for the streaming handler: it's the one under sustained concurrent
# load (one open invocation per active chat stream), and a throttle there means a user's message
# silently never started.
resource "aws_cloudwatch_metric_alarm" "ws_send_message_throttles" {
  alarm_name          = "chatrock-ws_send_message-throttles-${var.env}"
  alarm_description   = "ws_send_message Lambda is being throttled — concurrent chat streams may be failing to start"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.ws_send_message.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# ── Bedrock call failures ───────────────────────────────────────────────────
# ws_send_message is the primary Bedrock caller (chat streaming + all agentic tool use); it logs
# a single `stream_error` line (console.error, backend/CLAUDE.md "CloudWatch logging" table) for
# any hard failure in the ConverseStream loop — model errors, throttling, malformed history, etc.
# http_chats (title generation) and http_projects (file summarization) also call Bedrock via
# converseOnce but log-and-continue on failure rather than erroring the request, and are already
# covered by their own Lambda Errors alarms above for anything that does escape.
resource "aws_cloudwatch_log_metric_filter" "stream_error" {
  name           = "chatrock-stream-error-${var.env}"
  log_group_name = "/aws/lambda/${aws_lambda_function.ws_send_message.function_name}"
  pattern        = "{ $.event = \"stream_error\" }"

  metric_transformation {
    name      = "StreamErrors"
    namespace = "Chatrock/${var.env}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "stream_error" {
  alarm_name          = "chatrock-stream-error-${var.env}"
  alarm_description   = "Bedrock ConverseStream call(s) failed in the chat streaming handler"
  namespace           = "Chatrock/${var.env}"
  metric_name         = "StreamErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# Cross-account Bedrock auth (ssm.tf / backend/src/lib/bedrockAuth.ts): a real bearer token is
# expected to load from SSM whenever bedrock_bearer_token isn't UNSET. `ssm_read_failed` means
# the SSM GetParameter call itself errored (permissions, throttling, param deleted) — the app
# silently falls back to native IAM either way, so this never breaks chat, but it's worth knowing
# about since it means calls are quietly landing in the wrong AWS account's Bedrock quota.
resource "aws_cloudwatch_log_metric_filter" "bedrock_auth_ssm_failed" {
  name           = "chatrock-bedrock-auth-ssm-failed-${var.env}"
  log_group_name = "/aws/lambda/${aws_lambda_function.ws_send_message.function_name}"
  pattern        = "{ $.event = \"bedrock_auth\" && $.reason = \"ssm_read_failed\" }"

  metric_transformation {
    name      = "BedrockAuthSsmFailures"
    namespace = "Chatrock/${var.env}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "bedrock_auth_ssm_failed" {
  alarm_name          = "chatrock-bedrock-auth-ssm-failed-${var.env}"
  alarm_description   = "Failed to read the Bedrock bearer-token SSM parameter — silently falling back to native IAM"
  namespace           = "Chatrock/${var.env}"
  metric_name         = "BedrockAuthSsmFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# ── Cascade-delete DLQ ───────────────────────────────────────────────────────
# Any message here (root CLAUDE.md "Chat deletion & sensitive/ephemeral chats") means a chat's
# message/S3 cascade-delete failed after retries — an orphaned-data leak, not a transient blip.
resource "aws_cloudwatch_metric_alarm" "chat_cleanup_dlq_depth" {
  alarm_name          = "chatrock-chat-cleanup-dlq-depth-${var.env}"
  alarm_description   = "chat_cleanup_dlq has messages — a chat delete/TTL cascade failed after retries"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.chat_cleanup_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# ── API Gateway ──────────────────────────────────────────────────────────────
# HTTP API exposes a `5xx` metric directly (AWS/ApiGateway, confirmed via
# `aws cloudwatch list-metrics --namespace AWS/ApiGateway --dimensions Name=ApiId,Value=<id>`).
resource "aws_cloudwatch_metric_alarm" "http_api_5xx" {
  alarm_name          = "chatrock-http-api-5xx-${var.env}"
  alarm_description   = "HTTP API is returning 5xx responses"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.http.id, Stage = aws_apigatewayv2_stage.http.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

# WebSocket APIs have no `5xx` metric — `ExecutionError` (confirmed the same way) is the closest
# equivalent: failures executing the route (integration/backend errors), as opposed to
# `ClientError` (bad requests/auth failures, expected background noise from e.g. expired tokens).
resource "aws_cloudwatch_metric_alarm" "ws_api_execution_error" {
  alarm_name          = "chatrock-ws-api-execution-error-${var.env}"
  alarm_description   = "WebSocket API route execution is failing (backend/integration errors)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "ExecutionError"
  dimensions          = { ApiId = aws_apigatewayv2_api.ws.id, Stage = aws_apigatewayv2_stage.ws.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = { Env = var.env }
}

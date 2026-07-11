# Cascade-delete cleanup for chats. Triggered by the DynamoDB Stream on Chat-item REMOVE
# events (manual DELETE /api/chats/{chatId} or TTL expiry of a private chat) — deletes that
# chat's Message items + S3 attachments. See "Chat deletion & temporary/private chats" in
# backend/CLAUDE.md for the full design rationale.

resource "aws_sqs_queue" "chat_cleanup_dlq" {
  name                      = "chatrock-chat-cleanup-dlq-${var.env}"
  message_retention_seconds = 1209600 # 14 days — time to notice + replay a failed cleanup
  tags                      = { Env = var.env }
}

resource "aws_lambda_function" "stream_chat_cleanup" {
  function_name    = "chatrock-stream-chatCleanup-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/stream-chatCleanup.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/stream-chatCleanup.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 60
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_event_source_mapping" "chat_cleanup" {
  event_source_arn  = aws_dynamodb_table.chatrock.stream_arn
  function_name     = aws_lambda_function.stream_chat_cleanup.arn
  starting_position = "LATEST"
  batch_size        = 10

  # Only Chat-item deletes (PK=USER#<sub>, SK=CHAT#<chatId>) — Message-item removals
  # (PK=CHAT#<chatId>) must never reach this Lambda, since it deletes Message items itself
  # and a Message-item REMOVE would otherwise trigger a wasted / recursive-looking invocation.
  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
        dynamodb = {
          Keys = {
            PK = { S = [{ prefix = "USER#" }] }
            SK = { S = [{ prefix = "CHAT#" }] }
          }
        }
      })
    }
  }

  maximum_retry_attempts = 3

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.chat_cleanup_dlq.arn
    }
  }
}

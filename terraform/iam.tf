data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "chatrock-lambda-${var.env}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = { Env = var.env }
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Allow API Gateway to write access logs to CloudWatch
resource "aws_iam_role" "apigw_cloudwatch" {
  name = "chatrock-apigw-cloudwatch-${var.env}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "apigateway.amazonaws.com" }
    }]
  })
  tags = { Env = var.env }
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  role       = aws_iam_role.apigw_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "chatrock" {
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch.arn
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [aws_dynamodb_table.chatrock.arn]
  }

  statement {
    actions = ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${var.aws_region}::foundation-model/*",
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }

  # Bedrock Mantle (OpenAI Responses API, lib/llm/providers/bedrockMantle.ts) signs as a
  # distinct service (`bedrock-mantle`, not `bedrock`) with its own action namespace and
  # resource type — NOT the foundation-model/inference-profile ARNs above. Action + resource
  # ARN confirmed empirically from a real AccessDeniedException (not guessed — the SDK gives
  # no documented IAM reference for this as of Aug 2026): "arn:aws:bedrock-mantle:us-east-1:
  # <account>:project/default" is a fixed per-account "default" project, not per-model.
  # us-east-1-hardcoded since Mantle models are pinned there (see config/models.ts) regardless
  # of var.aws_region.
  statement {
    sid       = "InvokeBedrockMantle"
    actions   = ["bedrock-mantle:CreateInference"]
    resources = ["arn:aws:bedrock-mantle:us-east-1:${data.aws_caller_identity.current.account_id}:project/default"]
  }

  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["arn:aws:execute-api:${var.aws_region}:*:${aws_apigatewayv2_api.ws.id}/*"]
  }

  # Bedrock auto-subscribes the account to a foundation model on first invocation; these
  # marketplace actions aren't resource-scoped (no ARN to constrain to).
  statement {
    sid       = "MarketplaceModelSubscribe"
    actions   = ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"]
    resources = ["*"]
  }

  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.attachments.arn}/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.attachments.arn]
  }

  # DynamoDB Streams read access for the cascade-delete cleanup Lambda (stream_chat_cleanup,
  # lambda.tf) — triggered on Chat-item REMOVE events (manual delete or TTL expiry) to fan
  # out the cascade delete of that chat's messages + S3 attachments.
  statement {
    sid       = "DynamoStreamRead"
    actions   = ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"]
    resources = ["${aws_dynamodb_table.chatrock.arn}/stream/*"]
  }

  # Event source mapping on-failure destination for stream_chat_cleanup.
  statement {
    sid       = "StreamCleanupDlq"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.chat_cleanup_dlq.arn]
  }

  statement {
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.cloudfront_attachments_private_key.arn,
      aws_ssm_parameter.bedrock_bearer_token.arn,
    ]
  }

  # Caller-side permission for the AgentCore Web Search MCP gateway (see agentcore.tf).
  # This is distinct from aws_iam_role.agentcore_gateway, which AgentCore itself assumes.
  statement {
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = [aws_bedrockagentcore_gateway.web_search.gateway_arn]
  }

  # AgentCore Browser — unlike Web Search, this is a direct data-plane session API (no
  # Gateway, no second assumed role): the Lambda's own execution role signs StartBrowserSession/
  # StopBrowserSession calls and the CDP WebSocket handshake directly (see
  # backend/src/lib/agentcore/browser.ts). Confirmed working natively in ap-southeast-2 (no
  # cross-region pin needed, unlike Web Search's us-east-1-only Gateway).
  #
  # The AWS-managed system browser (aws.browser.v1) lives under the literal "aws"
  # pseudo-account, not the caller's own account — same pattern as Web Search's system tool
  # ARN below (arn:...:tool/web-search.v1). Confirmed via the actual AccessDeniedException
  # message when this was first scoped to the caller's account: resource
  # "arn:aws:bedrock-agentcore:ap-southeast-2:aws:browser/aws.browser.v1".
  statement {
    sid = "InvokeBrowser"
    actions = [
      "bedrock-agentcore:StartBrowserSession",
      "bedrock-agentcore:GetBrowserSession",
      "bedrock-agentcore:StopBrowserSession",
      "bedrock-agentcore:ConnectBrowserAutomationStream",
    ]
    resources = ["arn:aws:bedrock-agentcore:${var.aws_region}:aws:browser/aws.browser.v1"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "chatrock-lambda-policy-${var.env}"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

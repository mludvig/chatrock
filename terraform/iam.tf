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

  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["arn:aws:execute-api:${var.aws_region}:*:${aws_apigatewayv2_api.ws.id}/*"]
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

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.cloudfront_attachments_private_key.arn]
  }

  # Caller-side permission for the AgentCore Web Search MCP gateway (see agentcore.tf).
  # This is distinct from aws_iam_role.agentcore_gateway, which AgentCore itself assumes.
  statement {
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = [aws_bedrockagentcore_gateway.web_search.gateway_arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "chatrock-lambda-policy-${var.env}"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

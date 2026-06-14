locals {
  lambda_runtime = "nodejs20.x"
  lambda_env_base = {
    APP_ENV                             = var.env
    DOMAIN_NAME                         = var.domain_name
    DEFAULT_MODEL                       = var.default_model
    DYNAMO_TABLE                        = aws_dynamodb_table.chatrock.name
    COGNITO_USER_POOL_ID                = aws_cognito_user_pool.chatrock.id
    COGNITO_CLIENT_ID                   = aws_cognito_user_pool_client.spa.id
    JINA_API_KEY                        = var.jina_api_key
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    ATTACHMENTS_BUCKET                  = aws_s3_bucket.attachments.id
    CLOUDFRONT_DOMAIN                   = "https://${var.domain_name}"
    CLOUDFRONT_KEY_PAIR_ID              = aws_cloudfront_public_key.attachments.id
    CLOUDFRONT_PRIVATE_KEY_SSM          = aws_ssm_parameter.cloudfront_attachments_private_key.name
  }
}

# ── HTTP CRUD handlers ──────────────────────────────────────────────────────
resource "aws_lambda_function" "http_chats" {
  function_name    = "chatrock-http-chats-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-chats.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-chats.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 30
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_chats_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_chats.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_function" "http_messages" {
  function_name    = "chatrock-http-messages-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-messages.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-messages.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 30
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_messages_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_messages.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_function" "http_models" {
  function_name    = "chatrock-http-models-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-models.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-models.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_models_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_models.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_function" "http_preferences" {
  function_name    = "chatrock-http-preferences-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-preferences.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-preferences.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 30
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_preferences_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_preferences.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_function" "http_memory" {
  function_name    = "chatrock-http-memory-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-memory.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-memory.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 30
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_memory_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_memory.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

# ── WebSocket handlers ──────────────────────────────────────────────────────
resource "aws_lambda_function" "ws_authorizer" {
  function_name    = "chatrock-ws-authorizer-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-authorizer.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-authorizer.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_authorizer_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_lambda_function" "ws_connect" {
  function_name    = "chatrock-ws-connect-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-connect.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-connect.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_connect_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_lambda_function" "ws_disconnect" {
  function_name    = "chatrock-ws-disconnect-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-disconnect.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-disconnect.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_disconnect_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_lambda_function" "ws_send_message" {
  function_name    = "chatrock-ws-sendMessage-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-sendMessage.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-sendMessage.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 300
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_send_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_send_message.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_lambda_function" "ws_cancel_message" {
  function_name    = "chatrock-ws-cancelMessage-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-cancelMessage.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-cancelMessage.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_cancel_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_cancel_message.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

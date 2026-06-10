resource "aws_apigatewayv2_api" "http" {
  name          = "chatrock-http-${var.env}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://${var.domain_name}"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
    max_age       = 300
  }

  tags = { Env = var.env }
}

resource "aws_cloudwatch_log_group" "apigw_http" {
  name              = "/aws/apigateway/chatrock-http-${var.env}"
  retention_in_days = 90
  tags              = { Env = var.env }
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_http.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      sourceIp       = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      authError      = "$context.authorizer.error"
    })
  }
}

# JWT authorizer (Cognito)
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spa.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.chatrock.id}"
  }
}

# ── Integrations ────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_integration" "http_chats" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_chats.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "http_messages" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_messages.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "http_models" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_models.invoke_arn
  payload_format_version = "2.0"
}

# ── Routes ──────────────────────────────────────────────────────────────────

# Authenticated CRUD routes
resource "aws_apigatewayv2_route" "chats_list" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /api/chats"
  target             = "integrations/${aws_apigatewayv2_integration.http_chats.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "chats_create" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /api/chats"
  target             = "integrations/${aws_apigatewayv2_integration.http_chats.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "chats_update" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "PATCH /api/chats/{chatId}"
  target             = "integrations/${aws_apigatewayv2_integration.http_chats.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "chats_delete" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "DELETE /api/chats/{chatId}"
  target             = "integrations/${aws_apigatewayv2_integration.http_chats.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "chats_retitle" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /api/chats/{chatId}/retitle"
  target             = "integrations/${aws_apigatewayv2_integration.http_chats.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "messages_list" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /api/chats/{chatId}/messages"
  target             = "integrations/${aws_apigatewayv2_integration.http_messages.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "models" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /api/models"
  target             = "integrations/${aws_apigatewayv2_integration.http_models.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

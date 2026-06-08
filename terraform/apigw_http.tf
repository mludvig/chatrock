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

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
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
resource "aws_apigatewayv2_integration" "http_hello" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_hello.invoke_arn
  payload_format_version = "2.0"
}

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

# Smoke-test (unauthenticated)
resource "aws_apigatewayv2_route" "hello" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /api/hello"
  target    = "integrations/${aws_apigatewayv2_integration.http_hello.id}"
}

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

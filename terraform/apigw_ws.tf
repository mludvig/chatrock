resource "aws_apigatewayv2_api" "ws" {
  name                       = "chatrock-ws-${var.env}"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = { Env = var.env }
}

resource "aws_apigatewayv2_authorizer" "ws_lambda" {
  api_id           = aws_apigatewayv2_api.ws.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_function.ws_authorizer.invoke_arn
  identity_sources = ["route.request.querystring.token"]
  name             = "ws-lambda-auth"
  # TTL caching not supported for WEBSOCKET protocol APIs
}

resource "aws_cloudwatch_log_group" "apigw_ws" {
  name              = "/aws/apigateway/chatrock-ws-${var.env}"
  retention_in_days = 90
  tags              = { Env = var.env }
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "ws"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_ws.arn
    format = jsonencode({
      requestId    = "$context.requestId"
      sourceIp     = "$context.identity.sourceIp"
      requestTime  = "$context.requestTime"
      routeKey     = "$context.routeKey"
      connectionId = "$context.connectionId"
      status       = "$context.status"
      authError    = "$context.authorizer.error"
    })
  }
}

# ── Integrations ────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_integration" "ws_connect" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ws_connect.invoke_arn
}

resource "aws_apigatewayv2_integration" "ws_disconnect" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ws_disconnect.invoke_arn
}

resource "aws_apigatewayv2_integration" "ws_send" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ws_send_message.invoke_arn
}

# ── Routes ──────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_route" "ws_connect" {
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = "$connect"
  target             = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.ws_lambda.id
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_disconnect.id}"
}

resource "aws_apigatewayv2_route" "ws_send" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "sendMessage"
  target    = "integrations/${aws_apigatewayv2_integration.ws_send.id}"
}

resource "aws_apigatewayv2_integration" "ws_cancel" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ws_cancel_message.invoke_arn
}

resource "aws_apigatewayv2_route" "ws_cancel" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "cancelMessage"
  target    = "integrations/${aws_apigatewayv2_integration.ws_cancel.id}"
}

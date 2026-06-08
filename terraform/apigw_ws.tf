resource "aws_apigatewayv2_api" "ws" {
  name                       = "chatrock-ws-${var.env}"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = { Env = var.env }
}

resource "aws_apigatewayv2_authorizer" "ws_lambda" {
  api_id                           = aws_apigatewayv2_api.ws.id
  authorizer_type                  = "REQUEST"
  authorizer_uri                   = aws_lambda_function.ws_authorizer.invoke_arn
  identity_sources                 = ["route.request.querystring.token"]
  name                             = "ws-lambda-auth"
  authorizer_result_ttl_in_seconds = 300
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "prod"
  auto_deploy = true
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

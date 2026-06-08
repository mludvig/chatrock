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

# Hello handler integration (smoke test — will be replaced in Phase C)
resource "aws_apigatewayv2_integration" "http_hello" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_hello.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "hello" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /api/hello"
  target    = "integrations/${aws_apigatewayv2_integration.http_hello.id}"
}

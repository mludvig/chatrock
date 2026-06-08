locals {
  lambda_runtime = "nodejs20.x"
  lambda_env_base = {
    APP_ENV       = var.env
    DOMAIN_NAME   = var.domain_name
    DEFAULT_MODEL = var.default_model
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
  }
}

resource "aws_lambda_function" "http_hello" {
  function_name    = "chatrock-http-hello-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/http-hello.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/http-hello.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10

  environment {
    variables = local.lambda_env_base
  }

  tags = { Env = var.env }
}

resource "aws_lambda_permission" "http_hello_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_hello.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

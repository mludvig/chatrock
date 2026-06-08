output "app_url" {
  value = "https://${var.domain_name}"
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.chatrock.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.chatrock.id
}

output "http_api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "s3_bucket" {
  value = aws_s3_bucket.spa.bucket
}

output "ws_api_endpoint" {
  # Direct API GW endpoint (not via CloudFront) — CF cannot rewrite /ws/prod → /prod
  value = "wss://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/prod"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.chatrock.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.spa.id
}

output "cognito_hosted_ui_domain" {
  value = "https://${aws_cognito_user_pool_domain.chatrock.domain}.auth.${var.aws_region}.amazoncognito.com"
}

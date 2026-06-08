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

# Populated in Phase D (WebSocket API)
output "ws_api_endpoint" {
  value = "wss://${var.domain_name}/ws/prod"
}

# Populated in Phase E (Cognito) — empty string until then
output "cognito_user_pool_id" {
  value = var.cognito_user_pool_id_override
}

output "cognito_client_id" {
  value = var.cognito_client_id_override
}

output "cognito_hosted_ui_domain" {
  value = var.cognito_hosted_ui_domain_override
}

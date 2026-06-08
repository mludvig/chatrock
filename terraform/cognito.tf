resource "aws_cognito_user_pool" "chatrock" {
  name = "chatrock-${var.env}"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  tags = { Env = var.env }
}

resource "aws_cognito_user_pool_domain" "chatrock" {
  domain       = "chatrock-${var.env}-auth"
  user_pool_id = aws_cognito_user_pool.chatrock.id
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "chatrock-spa"
  user_pool_id = aws_cognito_user_pool.chatrock.id

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  callback_urls = ["https://${var.domain_name}/callback"]
  logout_urls   = ["https://${var.domain_name}/"]

  supported_identity_providers = ["COGNITO"]
  generate_secret              = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]
}

variable "aws_region" {
  description = "Primary AWS region"
  default     = "ap-southeast-2"
}

variable "domain_name" {
  description = "Full domain for the app, e.g. chatrock.ccxdemo.dev"
  type        = string
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone name, e.g. ccxdemo.dev"
  type        = string
}

variable "env" {
  description = "Environment name (used in resource names)"
  default     = "prod"
}

variable "default_model" {
  description = "Default Bedrock model ID for chat"
  default     = "apac.anthropic.claude-sonnet-4-6"
}

# Placeholder overrides — replaced by real resources in Phase E (Cognito)
variable "cognito_user_pool_id_override" {
  description = "Cognito User Pool ID (set automatically once Cognito is provisioned)"
  default     = ""
}

variable "cognito_client_id_override" {
  description = "Cognito App Client ID (set automatically once Cognito is provisioned)"
  default     = ""
}

variable "cognito_hosted_ui_domain_override" {
  description = "Cognito Hosted UI domain URL (set automatically once Cognito is provisioned)"
  default     = ""
}

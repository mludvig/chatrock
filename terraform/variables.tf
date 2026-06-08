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

variable "jina_api_key" {
  description = "Jina AI API key for web search (optional — search disabled if empty)"
  default     = ""
  sensitive   = true
}

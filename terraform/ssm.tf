# RSA key pair for CloudFront attachment URL signing.
# Rotate: terraform taint tls_private_key.attachments_cf && terraform apply
resource "tls_private_key" "attachments_cf" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_ssm_parameter" "cloudfront_attachments_private_key" {
  name        = "/chatrock/cloudfront/attachments_private_key"
  description = "RSA private key for signing CloudFront attachment URLs"
  type        = "SecureString"
  value       = tls_private_key.attachments_cf.private_key_pem
  tags        = { Env = var.env }
}

output "cloudfront_attachments_key_pair_id" {
  value = aws_cloudfront_public_key.attachments.id
}

# Cross-account Bedrock auth: holds a Bedrock API key (bearer token) for calling Bedrock in a
# different AWS account than the one this app runs in (e.g. one with Bedrock credits) — see
# https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html. Terraform only creates the
# parameter as a placeholder; the real value is set out-of-band (`aws ssm put-parameter
# --name /chatrock/bedrock/bearer_token --value <token> --type SecureString --overwrite`), and
# `ignore_changes` keeps `terraform apply` from ever stomping on it. Lambdas read whatever value
# is there at cold start (backend/src/lib/bedrockAuth.ts) — empty/placeholder means "use this
# Lambda's own IAM role" (native same-account access), a real token means "use bearer auth
# against the account that issued it".
resource "aws_ssm_parameter" "bedrock_bearer_token" {
  name        = "/chatrock/bedrock/bearer_token"
  description = "Bedrock API key (bearer token) for cross-account Bedrock calls. Set manually via aws ssm put-parameter --overwrite. SSM SecureString values can't be empty, so set it back to UNSET (not \"\") to disable and fall back to this Lambda's native IAM role."
  type        = "SecureString"
  value       = "UNSET"
  tags        = { Env = var.env }

  lifecycle {
    ignore_changes = [value]
  }
}

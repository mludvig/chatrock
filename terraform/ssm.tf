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

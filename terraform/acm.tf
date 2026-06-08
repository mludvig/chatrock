# ACM cert MUST be in us-east-1 for CloudFront
resource "aws_acm_certificate" "chatrock" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = { Env = var.env }

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.chatrock.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "chatrock" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.chatrock.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

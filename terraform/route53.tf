resource "aws_route53_record" "chatrock" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.chatrock.domain_name
    zone_id                = aws_cloudfront_distribution.chatrock.hosted_zone_id
    evaluate_target_health = false
  }
}

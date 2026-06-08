locals {
  s3_origin_id       = "s3-spa"
  http_api_origin_id = "http-api"
  ws_api_origin_id   = "ws-api"
  http_api_hostname  = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
  ws_api_hostname    = "${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com"
}

resource "aws_cloudfront_distribution" "chatrock" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  web_acl_id          = aws_wafv2_web_acl.chatrock.arn
  price_class         = "PriceClass_100"

  # ── Origins ──────────────────────────────────────────────────────────────
  origin {
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  origin {
    domain_name = local.http_api_hostname
    origin_id   = local.http_api_origin_id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name = local.ws_api_hostname
    origin_id   = local.ws_api_origin_id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # ── Cache behaviors ───────────────────────────────────────────────────────

  # /ws* → WebSocket API (passthrough, no cache)
  ordered_cache_behavior {
    path_pattern           = "/ws*"
    target_origin_id       = local.ws_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
    compress    = false
  }

  # /api/* → HTTP API (no cache, forward auth header)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.http_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Origin"]
      cookies { forward = "none" }
    }
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
    compress    = true
  }

  # Default → S3 SPA assets
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
    compress    = true
  }

  # SPA client-side routing fallback
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.chatrock.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Env = var.env }
}

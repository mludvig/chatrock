locals {
  s3_origin_id             = "s3-spa"
  s3_attachments_origin_id = "s3-attachments"
  http_api_origin_id       = "http-api"
  ws_api_origin_id         = "ws-api"
  http_api_hostname        = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
  ws_api_hostname          = "${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com"
}

# CloudFront Function: rewrite extensionless paths to /index.html for SPA routing.
# This replaces the global custom_error_response approach, which would intercept
# 4xx errors from ALL origins (including the API) and break JSON error responses.
resource "aws_cloudfront_function" "spa_router" {
  name    = "chatrock-spa-router-${var.env}"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite extensionless paths to /index.html for SPA routing"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      // If no file extension in the last path segment, treat as an SPA route
      if (uri !== '/' && uri.lastIndexOf('.') <= uri.lastIndexOf('/')) {
        request.uri = '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_public_key" "attachments" {
  name        = "chatrock-attachments-key-${var.env}"
  encoded_key = tls_private_key.attachments_cf.public_key_pem
}

resource "aws_cloudfront_key_group" "attachments" {
  name    = "chatrock-attachments-keygroup-${var.env}"
  items   = [aws_cloudfront_public_key.attachments.id]
  comment = "Attachment download signing"
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
    domain_name              = aws_s3_bucket.attachments.bucket_regional_domain_name
    origin_id                = local.s3_attachments_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.attachments.id
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

  # /ws* → WebSocket API
  # Uses managed policies: CachingDisabled + AllViewer so all WebSocket headers
  # (Upgrade, Connection, Sec-WebSocket-*) and the ?token= query param are forwarded.
  # viewer_protocol_policy must be https-only — browsers can't follow HTTP→HTTPS
  # redirects for WebSocket connections so redirect-to-https would break ws://.
  ordered_cache_behavior {
    path_pattern             = "/ws*"
    target_origin_id         = local.ws_api_origin_id
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
    compress                 = false
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

  # /attachments/* → S3 attachments (signed URLs only)
  ordered_cache_behavior {
    path_pattern               = "/attachments/*"
    target_origin_id           = local.s3_attachments_origin_id
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    trusted_key_groups         = [aws_cloudfront_key_group.attachments.id]
    forwarded_values {
      query_string = true
      cookies { forward = "none" }
    }
    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
    compress    = true
  }

  # Default → S3 SPA assets
  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
    compress    = true

    # Rewrite unknown SPA routes (no file extension) to /index.html before hitting S3.
    # Using a CloudFront Function avoids the global custom_error_response approach,
    # which intercepts 4xx errors from ALL origins and corrupts API JSON error responses.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_router.arn
    }
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

# ── CloudFront standard logs v2 → S3 (JSON, Hive-partitioned) ────────────────
# Replaces the legacy logging_config block (v1 flat layout, us-east-1 only).
# The CloudWatch vended-logs API must be called in us-east-1 regardless of the
# S3 bucket's region.

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  provider     = aws.us_east_1
  name         = "chatrock-cloudfront-access-logs-${var.env}"
  resource_arn = aws_cloudfront_distribution.chatrock.arn
  log_type     = "ACCESS_LOGS"
}

resource "aws_cloudwatch_log_delivery_destination" "cloudfront_s3" {
  provider      = aws.us_east_1
  name          = "chatrock-cloudfront-s3-${var.env}"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = "${aws_s3_bucket.logs.arn}/cloudfront"
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront" {
  provider                 = aws.us_east_1
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront_s3.arn

  s3_delivery_configuration = [{
    suffix_path                 = "{yyyy}/{MM}/{dd}/{HH}"
    enable_hive_compatible_path = true
  }]
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "chatrock-security-headers-${var.env}"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }
}

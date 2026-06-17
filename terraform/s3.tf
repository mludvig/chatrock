# ── Centralised logging bucket ────────────────────────────────────────────────
# Must be in us-east-1: CloudFront standard logs v2 delivery resources require
# us-east-1, and v1 logging_config also only delivers to us-east-1 buckets.

resource "aws_s3_bucket" "logs" {
  provider         = aws.us_east_1
  bucket           = "chatrock-logs-${var.env}-${data.aws_caller_identity.current.account_id}-us-east-1-an"
  bucket_namespace = "account-regional"
  tags             = { Env = var.env }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  provider                = aws.us_east_1
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    expiration { days = 90 }
    filter { prefix = "" }
  }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_acl" "logs" {
  provider   = aws.us_east_1
  bucket     = aws_s3_bucket.logs.id
  acl        = "log-delivery-write"
  depends_on = [aws_s3_bucket_ownership_controls.logs, aws_s3_bucket_public_access_block.logs]
}

# Bucket policy for CloudFront standard logs v2 (delivery.logs.amazonaws.com).
# The legacy ACL above covers WAF/Firehose; this policy covers the newer vended-logs delivery.
data "aws_iam_policy_document" "logs_delivery_write" {
  statement {
    sid    = "AWSLogsDeliveryWrite"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "AWSLogsDeliveryAclCheck"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = [aws_s3_bucket.logs.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  provider   = aws.us_east_1
  bucket     = aws_s3_bucket.logs.id
  policy     = data.aws_iam_policy_document.logs_delivery_write.json
  depends_on = [aws_s3_bucket_public_access_block.logs]
}

# ── SPA bucket ────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "spa" {
  bucket           = "chatrock-spa-${var.env}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-an"
  bucket_namespace = "account-regional"
  tags             = { Env = var.env }
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket                  = aws_s3_bucket.spa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "chatrock-spa-oac-${var.env}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "spa" {
  bucket     = aws_s3_bucket.spa.id
  policy     = data.aws_iam_policy_document.spa_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.spa]
}

data "aws_iam_policy_document" "spa_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.spa.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.chatrock.arn]
    }
  }
}

# ── Attachments bucket ────────────────────────────────────────────────────────

resource "aws_s3_bucket" "attachments" {
  bucket           = "chatrock-attachments-${data.aws_caller_identity.current.account_id}-${var.aws_region}-an"
  bucket_namespace = "account-regional"
  tags             = { Env = var.env }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_cors_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  cors_rule {
    allowed_origins = ["https://${var.domain_name}"]
    allowed_methods = ["PUT"]
    allowed_headers = ["Content-Type", "Origin"]
    max_age_seconds = 300
  }
}

resource "aws_cloudfront_origin_access_control" "attachments" {
  name                              = "chatrock-attachments-oac-${var.env}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "attachments" {
  bucket     = aws_s3_bucket.attachments.id
  policy     = data.aws_iam_policy_document.attachments_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.attachments]
}

data "aws_iam_policy_document" "attachments_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.chatrock.arn]
    }
  }
}

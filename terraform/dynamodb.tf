resource "aws_dynamodb_table" "chatrock" {
  name         = "chatrock-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  # KEYS_ONLY is enough: the cascade-cleanup Lambda (stream_chat_cleanup, lambda.tf) only
  # needs PK/SK to re-query messages and derive the S3 prefix — see the "Chat deletion &
  # temporary/private chats" note in backend/CLAUDE.md for the full design.
  stream_enabled   = true
  stream_view_type = "KEYS_ONLY"

  tags = { Env = var.env }
}

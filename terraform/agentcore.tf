# Amazon Bedrock AgentCore — Web Search, exposed to chatrock-ws-sendMessage via an MCP
# Gateway. Web Search is only available in us-east-1 as of June 2026, so the gateway is
# region-pinned there (cross-region call from the app's home region, ap-southeast-2).
#
# Inbound auth is AWS_IAM (SigV4) rather than CUSTOM_JWT — the Lambda's own execution role
# signs MCP requests directly, no separate Cognito machine-to-machine OAuth flow needed.
# See backend/src/lib/agentcore/gateway.ts for the client side.
#
# NOTE: the AWS provider (v6.51.0, latest as of writing) supports aws_bedrockagentcore_gateway
# but its aws_bedrockagentcore_gateway_target resource does not yet expose the "connector"
# target type that Web Search (and Managed Knowledge Bases) require — only lambda, mcp_server,
# api_gateway, open_api_schema, and smithy_model targets. Verified via `terraform providers
# schema -json`. Until the provider adds connector support, the target itself is a one-time
# manual step (see comment below) rather than a Terraform resource.

# Trust + permissions for the role AgentCore assumes to run the Gateway and call Web Search.
data "aws_iam_policy_document" "agentcore_gateway_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock-agentcore:us-east-1:${data.aws_caller_identity.current.account_id}:gateway/*"]
    }
  }
}

resource "aws_iam_role" "agentcore_gateway" {
  name               = "chatrock-agentcore-gateway-${var.env}"
  assume_role_policy = data.aws_iam_policy_document.agentcore_gateway_assume.json
  tags               = { Env = var.env }
}

data "aws_iam_policy_document" "agentcore_gateway_policy" {
  statement {
    sid       = "InvokeGateway"
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = ["arn:aws:bedrock-agentcore:us-east-1:${data.aws_caller_identity.current.account_id}:gateway/*"]
  }

  statement {
    sid       = "InvokeWebSearch"
    actions   = ["bedrock-agentcore:InvokeWebSearch"]
    resources = ["arn:aws:bedrock-agentcore:us-east-1:aws:tool/web-search.v1"]
  }
}

resource "aws_iam_role_policy" "agentcore_gateway" {
  name   = "chatrock-agentcore-gateway-policy-${var.env}"
  role   = aws_iam_role.agentcore_gateway.id
  policy = data.aws_iam_policy_document.agentcore_gateway_policy.json
}

# The MCP endpoint our Lambda calls (backend/src/lib/agentcore/gateway.ts).
resource "aws_bedrockagentcore_gateway" "web_search" {
  provider        = aws.us_east_1
  name            = "chatrock-web-search-${var.env}"
  role_arn        = aws_iam_role.agentcore_gateway.arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
  description     = "MCP gateway exposing the AgentCore Web Search connector to chatrock-ws-sendMessage"

  # This provider version doesn't read `description` back from the API, so every plan
  # would otherwise show a diff (documented provider limitation as of v6.51.0).
  lifecycle {
    ignore_changes = [description]
  }
}

# ── One-time manual step ──────────────────────────────────────────────────────
#
# The Web Search connector target can't be created by Terraform yet (see note above).
# Already done for prod (target name "web-search", status READY). For a new env, after
# the first `apply`, run this once (idempotent — AWS rejects a duplicate name):
#
#   aws bedrock-agentcore-control create-gateway-target \
#     --region us-east-1 \
#     --gateway-identifier "$(terraform -chdir=terraform output -raw agentcore_gateway_id)" \
#     --name web-search \
#     --target-configuration '{"mcp":{"connector":{"source":{"connectorId":"web-search"},"configurations":[{"name":"WebSearch","parameterValues":{}}]}}}' \
#     --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]'
#
# IMPORTANT: this requires AWS CLI >= 2.35.7 — the `connector` target type is too new for
# older CLI builds (the system CLI was 2.33.27 when this was written, which rejects
# `connector` with a parameter-validation error). Get a current build from
# https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip if `aws --version` is older.
#
# Re-run `aws bedrock-agentcore-control get-gateway-target --region us-east-1 \
#   --gateway-identifier <id> --target-id <id>` to confirm status reaches READY.
# Revisit this once aws_bedrockagentcore_gateway_target supports `connector` targets,
# and fold the above into a real resource.

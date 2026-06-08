#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Chatrock deploy script
#
# Usage:
#   ./deploy.sh                      full build + deploy
#   ./deploy.sh --backend-only       bundle lambdas + tf apply only (no frontend)
#   ./deploy.sh --frontend-only      build frontend + s3 sync + invalidation only
#   ./deploy.sh --tf-only            tf apply only (lambdas pre-built)
#   ./deploy.sh --skip-tf            build everything, skip terraform apply
# ──────────────────────────────────────────────────────────────────────────────

SKIP_BACKEND=false
SKIP_TERRAFORM=false
SKIP_FRONTEND=false

for arg in "$@"; do
  case $arg in
    --backend-only)  SKIP_FRONTEND=true ;;
    --frontend-only) SKIP_BACKEND=true; SKIP_TERRAFORM=true ;;
    --tf-only)       SKIP_BACKEND=true; SKIP_FRONTEND=true ;;
    --skip-tf)       SKIP_TERRAFORM=true ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$ROOT_DIR/terraform"

# ── 1. Backend: bundle Lambdas ─────────────────────────────────────────────
if [ "$SKIP_BACKEND" = false ]; then
  echo "▶ Building backend Lambdas..."
  cd "$ROOT_DIR/backend"
  npm install --silent
  npm run build
  echo "  ✓ Lambda zips written to terraform/dist/"
fi

# ── 2. Terraform apply ─────────────────────────────────────────────────────
if [ "$SKIP_TERRAFORM" = false ]; then
  echo "▶ Running terraform init..."
  cd "$TF_DIR"
  terraform init -input=false -upgrade

  echo "▶ Running terraform apply..."
  terraform apply -input=false -auto-approve
  echo "  ✓ Infrastructure deployed"
fi

# ── 3. Read Terraform outputs ──────────────────────────────────────────────
echo "▶ Reading Terraform outputs..."
cd "$TF_DIR"
HTTP_API_ENDPOINT=$(terraform output -raw http_api_endpoint)
WS_API_ENDPOINT=$(terraform output -raw ws_api_endpoint)
COGNITO_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_CLIENT_ID=$(terraform output -raw cognito_client_id)
COGNITO_HOSTED_UI_DOMAIN=$(terraform output -raw cognito_hosted_ui_domain)
S3_BUCKET=$(terraform output -raw s3_bucket)
DISTRIBUTION_ID=$(terraform output -raw cloudfront_distribution_id)
APP_URL=$(terraform output -raw app_url)

echo "  HTTP API : $HTTP_API_ENDPOINT"
echo "  App URL  : $APP_URL"

# ── 4. Frontend: build ─────────────────────────────────────────────────────
if [ "$SKIP_FRONTEND" = false ]; then
  echo "▶ Building frontend..."
  cd "$ROOT_DIR/frontend"
  npm install --silent

  VITE_API_BASE_URL="$HTTP_API_ENDPOINT" \
  VITE_WS_URL="$WS_API_ENDPOINT" \
  VITE_COGNITO_USER_POOL_ID="$COGNITO_USER_POOL_ID" \
  VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
  VITE_COGNITO_DOMAIN="$COGNITO_HOSTED_UI_DOMAIN" \
  VITE_APP_URL="$APP_URL" \
  npm run build

  echo "▶ Syncing to S3: s3://$S3_BUCKET"
  # Long-lived assets (hashed filenames from Vite)
  aws s3 sync dist/ "s3://$S3_BUCKET" \
    --delete \
    --cache-control "max-age=31536000,immutable" \
    --exclude "index.html"

  # index.html — always revalidate
  aws s3 cp dist/index.html "s3://$S3_BUCKET/index.html" \
    --cache-control "no-cache,no-store,must-revalidate"

  echo "▶ Creating CloudFront invalidation for distribution $DISTRIBUTION_ID..."
  INV_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' --output text)
  echo "  Invalidation ID: $INV_ID"

  echo "  ✓ Frontend deployed"
fi

echo ""
echo "✅  Chatrock deployed → $APP_URL"

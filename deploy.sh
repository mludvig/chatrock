#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Chatrock deploy script
#
# Subcommand usage (preferred):
#   ./deploy.sh [apply]    full build + deploy  (apply is the default)
#   ./deploy.sh plan       build backend zips if stale, then terraform plan
#   ./deploy.sh validate   build backend zips if stale, then terraform validate
#   ./deploy.sh frontend   build frontend if stale + s3 sync + invalidation
#   ./deploy.sh backend    build backend if stale + terraform apply (no frontend)
#   ./deploy.sh tf         terraform apply only (zips must already exist)
#
# All deploy paths (apply/backend/tf/frontend) end with a CloudFront invalidation.
# Rebuilds are skipped when source files are not newer than existing artifacts.
# Use --force-rebuild to override.
#
# Legacy flag usage (still supported):
#   ./deploy.sh --backend-only       = backend
#   ./deploy.sh --frontend-only      = frontend
#   ./deploy.sh --tf-only            = tf
#   ./deploy.sh --skip-tf            build everything, skip terraform apply
# ──────────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$ROOT_DIR/terraform"

# ── Resolve subcommand or legacy flags ────────────────────────────────────────
SUBCOMMAND=""
SKIP_BACKEND=false
SKIP_TERRAFORM=false
SKIP_FRONTEND=false
TF_ACTION="apply"
FORCE_REBUILD=false

for arg in "$@"; do
  case $arg in
    apply)         SUBCOMMAND="apply" ;;
    plan)          SUBCOMMAND="plan" ;;
    validate)      SUBCOMMAND="validate" ;;
    frontend)      SUBCOMMAND="frontend" ;;
    backend)       SUBCOMMAND="backend" ;;
    tf)            SUBCOMMAND="tf" ;;
    --force-rebuild) FORCE_REBUILD=true ;;
    --backend-only)  SKIP_FRONTEND=true ;;
    --frontend-only) SKIP_BACKEND=true; SKIP_TERRAFORM=true ;;
    --tf-only)       SKIP_BACKEND=true; SKIP_FRONTEND=true ;;
    --skip-tf)       SKIP_TERRAFORM=true ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 {apply|plan|validate|frontend|backend|tf} [--force-rebuild]"
      exit 1
      ;;
  esac
done

case "$SUBCOMMAND" in
  apply)    ;;
  plan)     SKIP_FRONTEND=true; TF_ACTION="plan" ;;
  validate) SKIP_FRONTEND=true; TF_ACTION="validate" ;;
  frontend) SKIP_BACKEND=true; SKIP_TERRAFORM=true ;;
  backend)  SKIP_FRONTEND=true ;;
  tf)       SKIP_BACKEND=true; SKIP_FRONTEND=true ;;
  "")       ;;
esac

# ── Helper: is_stale <artifact> <source_dirs...> ──────────────────────────────
is_stale() {
  local artifact="$1"; shift
  if [ "$FORCE_REBUILD" = true ]; then return 0; fi
  if [ ! -e "$artifact" ]; then return 0; fi
  local newer
  newer=$(find "$@" -newer "$artifact" -type f 2>/dev/null | head -1)
  [ -n "$newer" ]
}

# ── 1. Backend: bundle Lambdas ─────────────────────────────────────────────
if [ "$SKIP_BACKEND" = false ]; then
  NEWEST_ZIP="$TF_DIR/dist/ws-sendMessage.zip"
  if is_stale "$NEWEST_ZIP" \
       "$ROOT_DIR/backend/src" \
       "$ROOT_DIR/backend/package.json" \
       "$ROOT_DIR/backend/esbuild.config.mjs"; then
    echo "▶ Building backend Lambdas..."
    npm --prefix "$ROOT_DIR/backend" install --silent
    npm --prefix "$ROOT_DIR/backend" run build
    echo "  ✓ Lambda zips written to terraform/dist/"
  else
    echo "▶ Backend up-to-date, skipping build"
  fi
fi

# ── 2. Terraform ───────────────────────────────────────────────────────────
RUN_TF=false
[ "$SKIP_TERRAFORM" = false ] && RUN_TF=true
[ "$TF_ACTION" != "apply" ] && RUN_TF=true

if [ "$RUN_TF" = true ]; then
  echo "▶ Running terraform init..."
  terraform -chdir="$TF_DIR" init -input=false -upgrade

  case "$TF_ACTION" in
    apply)
      echo "▶ Running terraform validate..."
      terraform -chdir="$TF_DIR" validate
      echo "▶ Running terraform apply..."
      terraform -chdir="$TF_DIR" apply -input=false -auto-approve
      echo "  ✓ Infrastructure deployed"
      ;;
    plan)
      echo "▶ Running terraform plan..."
      terraform -chdir="$TF_DIR" plan -input=false
      exit 0
      ;;
    validate)
      echo "▶ Running terraform validate..."
      terraform -chdir="$TF_DIR" validate
      echo "  ✓ Configuration valid"
      exit 0
      ;;
  esac
fi

# ── 3. Read Terraform outputs (always needed for S3/CF steps) ─────────────
echo "▶ Reading Terraform outputs..."
HTTP_API_ENDPOINT=$(terraform -chdir="$TF_DIR" output -raw http_api_endpoint)
WS_API_ENDPOINT=$(terraform -chdir="$TF_DIR" output -raw ws_api_endpoint)
COGNITO_USER_POOL_ID=$(terraform -chdir="$TF_DIR" output -raw cognito_user_pool_id)
COGNITO_CLIENT_ID=$(terraform -chdir="$TF_DIR" output -raw cognito_client_id)
COGNITO_HOSTED_UI_DOMAIN=$(terraform -chdir="$TF_DIR" output -raw cognito_hosted_ui_domain)
S3_BUCKET=$(terraform -chdir="$TF_DIR" output -raw s3_bucket)
DISTRIBUTION_ID=$(terraform -chdir="$TF_DIR" output -raw cloudfront_distribution_id)
APP_URL=$(terraform -chdir="$TF_DIR" output -raw app_url)
echo "  App URL  : $APP_URL"

# ── 4. Frontend: build + S3 sync ──────────────────────────────────────────
if [ "$SKIP_FRONTEND" = false ]; then
  FRONTEND_ARTIFACT="$ROOT_DIR/frontend/dist/index.html"
  if is_stale "$FRONTEND_ARTIFACT" \
       "$ROOT_DIR/frontend/src" \
       "$ROOT_DIR/frontend/public" \
       "$ROOT_DIR/frontend/index.html" \
       "$ROOT_DIR/frontend/package.json" \
       "$ROOT_DIR/frontend/vite.config.ts"; then
    echo "▶ Building frontend..."
    npm --prefix "$ROOT_DIR/frontend" install --silent
    VITE_API_BASE_URL="$HTTP_API_ENDPOINT" \
    VITE_WS_URL="$WS_API_ENDPOINT" \
    VITE_COGNITO_USER_POOL_ID="$COGNITO_USER_POOL_ID" \
    VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
    VITE_COGNITO_DOMAIN="$COGNITO_HOSTED_UI_DOMAIN" \
    VITE_APP_URL="$APP_URL" \
    npm --prefix "$ROOT_DIR/frontend" run build
  else
    echo "▶ Frontend up-to-date, skipping build"
  fi

  echo "▶ Syncing to S3: s3://$S3_BUCKET"
  aws s3 sync "$ROOT_DIR/frontend/dist/" "s3://$S3_BUCKET" \
    --delete \
    --cache-control "max-age=31536000,immutable" \
    --exclude "index.html"
  aws s3 cp "$ROOT_DIR/frontend/dist/index.html" "s3://$S3_BUCKET/index.html" \
    --cache-control "no-cache,no-store,must-revalidate"
  echo "  ✓ Frontend synced"
fi

# ── 5. CloudFront invalidation (always after any deploy) ──────────────────
echo "▶ CloudFront invalidation (distribution $DISTRIBUTION_ID)..."
INV_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)
echo "  Invalidation ID: $INV_ID"

echo ""
echo "✅  Chatrock deployed → $APP_URL"

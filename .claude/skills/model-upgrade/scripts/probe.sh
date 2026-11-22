#!/usr/bin/env bash
# Bundle probe-model.ts with the backend's esbuild and run it against the live Bedrock API,
# using AWS_PROFILE/AWS_REGION from the repo's root .env.
#   probe.sh <modelId> [--caps '<json>'] [--only name,name]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
out="$(mktemp -d)/probe.cjs"

set -a; . "$repo/.env"; set +a

"$repo/backend/node_modules/.bin/esbuild" "$here/probe-model.ts" \
  --bundle --platform=node --target=node20 --format=cjs --log-level=warning \
  --loader:.txt=text \
  --external:@playwright/mcp --external:playwright-core --external:playwright --external:chromium-bidi \
  --outfile="$out"

REPO_ROOT="$repo" node "$out" "$@"

#!/usr/bin/env bash
# Bundles the AI worker Lambda into infra/build/ai-worker.zip (one ESM file, no node_modules),
# which infra/lambda.tf uploads. Run before `terraform plan` whenever worker code changes.
set -euo pipefail
cd "$(dirname "$0")/.."
out=infra/build/ai-worker
rm -rf "$out" infra/build/ai-worker.zip
mkdir -p "$out"
# --tsconfig pins the project's own config, so a tsconfig.json in a parent folder (outside the
# repo) can never affect the bundle.
npx esbuild src/worker/lambda.ts --tsconfig=tsconfig.json \
  --bundle --platform=node --target=node24 --format=esm --minify --sourcemap=inline \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --outfile="$out/index.mjs" --log-level=warning
# A fixed timestamp keeps the zip byte-identical when the code didn't change, so Terraform
# only sees a new version when there is one.
node -e 'const t = new Date("2026-01-01T00:00:00Z"); require("fs").utimesSync(process.argv[1], t, t)' "$out/index.mjs"
(cd "$out" && zip -q -X ../ai-worker.zip index.mjs)
echo "built infra/build/ai-worker.zip ($(du -h infra/build/ai-worker.zip | cut -f1))"

#!/usr/bin/env bash
# Deploy Novotel Duty Manager Report to production.
# Run on the VPS from /opt/data/novotel (any user with docker access).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Pulling latest code from GitHub (main)..."
git pull --ff-only origin main

echo "==> Building image..."
docker compose build

echo "==> Recreating container..."
docker compose up -d

echo "==> Waiting for health check..."
sleep 4
curl -fsS https://novotel.as-web.cloud/health && echo

echo "==> Deploy OK — https://novotel.as-web.cloud"
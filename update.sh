#!/bin/bash
set -Eeuo pipefail

TARGET_DIR="/var/www/purple-mc-panel/purple-panel"

echo "[1/4] Navigating to system panel core..."
cd "$TARGET_DIR"

echo "[2/4] Sanitizing local tracking tree..."
git config --global --add safe.directory "$TARGET_DIR" || true
git clean -fd

echo "[3/4] Pulling test code branches atomically..."
git fetch --all --tags
# While testing, keep this on dev-test. Switch to main for production later.
git reset --hard origin/dev-test

echo "[4/4] Optimizing dependency profiles and recycling daemons..."
npm install --omit=dev --no-audit --no-fund --quiet
chmod +x update.sh

HOME=/root pm2 restart purple-mc-panel-public --update-env
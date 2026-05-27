#!/bin/bash
set -Eeuo pipefail

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
cd "$TARGET_DIR"

echo "[1/4] Protecting minecraft server directory..."
if [ -d "server" ]; then
    echo "[SAFE] server/ directory detected — will not be touched"
fi
git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true

echo "[2/4] Saving local changes and fetching updates..."
STASH_REF=$(git stash --include-untracked 2>/dev/null || true)
git fetch --all --tags --prune 2>/dev/null || git fetch origin --prune

echo "[3/4] Applying panel updates (server/ excluded)..."
git reset --hard origin/main 2>/dev/null || git reset --hard origin/dev-test
# Restore user-config files that might have been overwritten (server.properties, settings.json, crash.log, eula.txt)
git checkout stash@\{0\} -- server/server.properties config/settings.json config/crash.log server/eula.txt 2>/dev/null || true
# Clean untracked files but NOT server/ (gitignored dirs are safe)
git clean -fd --exclude=server/ 2>/dev/null || true
if [ -n "$STASH_REF" ]; then
    git stash drop 2>/dev/null || true
fi

echo "[4/4] Installing dependencies and restarting..."
npm install --omit=dev --no-audit --no-fund 2>&1
chmod +x update.sh

HOME=/root pm2 restart purple-mc-panel --update-env 2>/dev/null || pm2 restart purple-mc-panel-public --update-env 2>/dev/null || pm2 restart all --update-env

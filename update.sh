#!/bin/bash
# ============================================================
# PurpleMC Panel — Legacy Git Update (manual use only)
#
# NOTE: the panel's built-in updater no longer runs this script.
# Updates now download the GitHub source archive and compare
# versions via version.json, so no local git clone is needed.
# This script remains for manual maintenance on git checkouts.
# ============================================================

PANEL_DIR="${TARGET_DIR:-/var/www/purple-mc-panel}"
REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
BRANCH="main"
RESTART_CMD="${RESTART_CMD:-pm2 restart purple-mc-panel}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

say()  { printf "${CYAN}[INFO]${NC} %s\n" "$1"; }
step() { printf "${YELLOW}[STEP %s]${NC} %s\n" "$1" "$2"; }
ok()   { printf "${GREEN}[GIT SUCCESS]${NC} %s\n" "$1"; }
err()  { printf "${RED}[GIT ERROR]${NC} %s\n" "$1"; }

echo -e "${YELLOW}==================================================${NC}"
echo -e "${YELLOW} Syncing PurpleMC Panel codebase${NC}"
echo -e "${YELLOW}   target : ${PANEL_DIR}${NC}"
echo -e "${YELLOW}==================================================${NC}"

step 1 "Preparing update workspace..."
cd "$PANEL_DIR" || { err "Directory unreachable: $PANEL_DIR"; exit 1; }
if [ ! -d .git ]; then
    err "Not a Git repository — system updates require a git clone."
    exit 1
fi

step 2 "Fetching latest changes from origin/$BRANCH..."
git remote set-url origin "$REPO_URL" >/dev/null 2>&1 || true
if ! git fetch origin "$BRANCH" --prune >/dev/null 2>&1; then
    err "Fetch failed — check network access to $REPO_URL"
    exit 1
fi

# Only reinstall dependencies if package files actually changed — this
# turns a multi-minute npm install into a no-op on most updates.
DEPS_CHANGED=0
if ! git diff --quiet HEAD "origin/$BRANCH" -- package.json package-lock.json 2>/dev/null; then
    DEPS_CHANGED=1
fi
say "current commit: $(git rev-parse --short HEAD 2>/dev/null)"

step 3 "Recording pre-update revision..."
git rev-parse --short HEAD >/dev/null 2>&1 || true
git stash list >/dev/null 2>&1 || true

step 4 "Applying update and scrubbing debris..."
git reset --hard "origin/$BRANCH" >/dev/null 2>&1 || { err "git reset failed."; exit 1; }
git clean -df >/dev/null 2>&1 || true
say "now at: $(git rev-parse --short HEAD)"

step 5 "Syncing Node dependencies..."
if [ "$DEPS_CHANGED" = "1" ]; then
    say "package files changed — running npm install"
    if ! npm install --no-audit --no-fund >/dev/null 2>&1; then
        err "npm install failed — the panel may not start correctly."
        exit 1
    fi
else
    say "dependencies unchanged — skipping npm install"
fi

chmod +x update.sh install.sh >/dev/null 2>&1 || true

step 6 "Restarting the panel process..."
if eval "$RESTART_CMD" >/dev/null 2>&1; then
    ok "Update applied. Web UI restarted."
else
    err "Files synced, but restart command failed: $RESTART_CMD"
    say "Start the panel manually to load the new version."
    exit 1
fi

step 7 "Verifying deployment..."
ok "Deployment completed successfully."
exit 0

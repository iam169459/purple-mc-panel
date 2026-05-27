#!/bin/bash

# --- Configuration ---
PANEL_DIR="/var/www/purple-mc-panel"
REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
BRANCH="main"

# Change this to your preferred Node process manager (e.g., "pm2 restart app.js" or "systemctl restart purple-panel")
RESTART_CMD="pm2 restart app.js" 

# Colors for scannable output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}==================================================${NC}"
echo -e "${YELLOW} Starting Full Update for: purple-mc-panel (${BRANCH})${NC}"
echo -e "${YELLOW}==================================================${NC}"

# 1. Navigate to directory
cd "$PANEL_DIR" || { echo -e "${RED}Error: Panel directory not found!${NC}"; exit 1; }

# 2. Ensure the remote URL is correctly pointed to your repo
git remote set-url origin "$REPO_URL" 2>/dev/null

# 3. Fetch all remote changes safely
echo -e "${YELLOW}[1/5] Fetching latest changes from GitHub...${NC}"
git fetch --all

# 4. Hard reset to discard old modified files and sync with remote main
echo -e "${YELLOW}[2/5] Resetting directory to match origin/${BRANCH} exactly...${NC}"
git reset --hard "origin/$BRANCH"

# 5. Wipe out old untracked files or deleted directory leftovers
echo -e "${YELLOW}[3/5] Cleaning up old, untracked junk files...${NC}"
git clean -df

# 6. Synchronize node modules (installs new, prunes deprecated)
echo -e "${YELLOW}[4/5] Syncing Node.js packages...${NC}"
npm prune
npm install --production

# 7. Ensure permissions are clean (optional but recommended for /var/www)
chmod +x update.sh install.sh 2>/dev/null

# 8. Restart the Node.js application interface only
echo -e "${YELLOW}[5/5] Executing panel restart command...${NC}"
eval "$RESTART_CMD"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}==================================================${NC}"
    echo -e "${GREEN} Success: Repository synced and Panel restarted!${NC}"
    echo -e "${GREEN} Note: Independent Minecraft servers were not touched.${NC}"
    echo -e "${GREEN}==================================================${NC}"
else
    echo -e "${RED}==================================================${NC}"
    echo -e "${RED} Warning: Update applied, but panel failed to restart.${NC}"
    echo -e "${RED} Please check your process manager logs.${NC}"
    echo -e "${RED}==================================================${NC}"
fi

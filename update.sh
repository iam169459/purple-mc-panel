#!/bin/bash

# --- Configuration ---
PANEL_DIR="/var/www/purple-mc-panel"
REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
BRANCH="main"
RESTART_CMD="pm2 restart purple-mc-panel"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# Safety trap to ensure cursor returns if script is broken off mid-spinner
cleanup() {
    tput cnorm
}
trap cleanup EXIT INT TERM

show_spinner() {
    local pid=$1
    local message=$2
    local delay=0.08
    local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    
    tput civis
    while kill -0 "$pid" 2>/dev/null; do
        for (( i=0; i<${#spinstr}; i++ )); do
            printf "\r${CYAN}[%c]${NC} %s" "${spinstr:$i:1}" "$message"
            sleep $delay
        done
    done
    printf "\r\033[K" # Clear line out
    tput cnorm
}

echo -e "${YELLOW}==================================================${NC}"
echo -e "${YELLOW} Syncing Panel codebase to origin/${BRANCH}...     ${NC}"
echo -e "${YELLOW}==================================================${NC}"

# 1. Navigate to directory
cd "$PANEL_DIR" || { echo -e "${RED}[ERR] Directory path unreachable!${NC}"; exit 1; }

# 2. Reset remote origin validation
git remote set-url origin "$REPO_URL" 2>/dev/null

# 3. Fetching updates
git fetch --all >/dev/null 2>&1 &
show_spinner $! "Scanning upstream git commits on remote..."

# 4. Hard resetting directory
git reset --hard "origin/$BRANCH" >/dev/null 2>&1 &
show_spinner $! "Overwriting altered tracking configurations..."

# 5. Scrub old artifacts
git clean -df >/dev/null 2>&1 &
show_spinner $! "Scrubbing un-tracked runtime debris files..."

# 6. Synchronizing Node Dependencies
npm prune >/dev/null 2>&1
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 &
show_spinner $! "Updating dependencies via production tree..."

# 7. Make scripts executable
chmod +x update.sh install.sh 2>/dev/null || true

# 8. Reload process engine without dropping Java child threads
echo -e "${CYAN}[INFO] Executing target manager restart...${NC}"
if eval "$RESTART_CMD" >/dev/null 2>&1; then
    echo -e "${GREEN}==================================================${NC}"
    echo -e "${GREEN} Update completed perfectly. Web UI restarted.    ${NC}"
    echo -e "${GREEN} Minecraft screen processes remain un-touched.   ${NC}"
    echo -e "${GREEN}==================================================${NC}"
else
    echo -e "${RED}==================================================${NC}"
    echo -e "${RED} [WARN] Files synced, but PM2 hook failed to turn. ${NC}"
    echo -e "${RED} Check process naming mappings manually.          ${NC}"
    echo -e "${RED}==================================================${NC}"
fi

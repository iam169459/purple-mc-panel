#!/bin/bash
set -Eeuo pipefail

# ──────────────────────────────────────────────
# PurpleMC Panel — Linux Auto-Installer (Animated)
# ──────────────────────────────────────────────

REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
INSTALL_DIR="/var/www/purple-mc-panel"
PANEL_DIR="$INSTALL_DIR"
PM2_NAME="purple-mc-panel"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# Safety reset for the cursor on exit or crash
cleanup() {
    tput cnorm 2>/dev/null || true
}
trap cleanup EXIT INT TERM

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERR]${NC} $1"; }

typewriter() {
    local text="$1"
    local delay=${2:-0.005}
    for (( i=0; i<${#text}; i++ )); do
        printf "%s" "${text:$i:1}"
        sleep "$delay"
    done
    echo ""
}

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
    printf "\r\033[K"
    tput cnorm
}

usage() {
    echo "Usage: $0 [options]"
    echo "Options:"
    echo "  --port <port>        Panel port (default: 3000, 1-65535)"
    echo "  --install-dir <path> Installation directory (default: $INSTALL_DIR)"
    echo "  --repo <url>         Git repository URL (default: $REPO_URL)"
    echo "  --branch <branch>    Git branch to deploy (default: main)"
    echo "  --pm2-name <name>    PM2 process name (default: $PM2_NAME)"
    echo "  --no-pm2             Skip PM2 setup"
    echo "  --no-java            Skip Java installation"
    echo "  --unattended         Run without prompts (requires root)"
    echo "  --help               Show this help"
}

# ── Parse arguments ──────────────────────────
PORT="3000"
BRANCH="main"
NO_PM2=false
NO_JAVA=false
UNATTENDED=false
NEEDS_NPM=true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)           PORT="${2:?Missing port value}"; shift 2 ;;
        --install-dir)    INSTALL_DIR="${2:?Missing install-dir value}"; PANEL_DIR="$INSTALL_DIR"; shift 2 ;;
        --repo)           REPO_URL="${2:?Missing repo URL}"; shift 2 ;;
        --branch)         BRANCH="${2:?Missing branch name}"; shift 2 ;;
        --pm2-name)       PM2_NAME="${2:?Missing PM2 name}"; shift 2 ;;
        --no-pm2)         NO_PM2=true; shift ;;
        --no-java)        NO_JAVA=true; shift ;;
        --unattended)     UNATTENDED=true; shift ;;
        --help|-h)        usage; exit 0 ;;
        *)                err "Unknown option: $1"; usage; exit 1 ;;
    esac
done

# Validate numeric options before touching anything.
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    err "Invalid port: $PORT (expected 1-65535)"
    exit 1
fi

if [[ $EUID -ne 0 ]]; then
    if $UNATTENDED; then
        err "This installer needs root privileges. Re-run with: sudo $0 $*"
        exit 1
    fi
    warn "It is recommended to run this installer as root (sudo)."
    read -rp "Continue without root? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

if [[ -t 1 ]] && ! $UNATTENDED; then
    clear
    typewriter "${CYAN}╔══════════════════════════════════════════╗${NC}" 0.002
    typewriter "${CYAN}║        PurpleMC Panel Installer          ║${NC}" 0.002
    typewriter "${CYAN}╚══════════════════════════════════════════╝${NC}" 0.002
    echo ""
else
    echo -e "${CYAN} PurpleMC Panel Installer ${NC} (unattended/non-TTY)"
fi

choose_mode() {
    local HAS_EXISTING=false
    [[ -d "$PANEL_DIR/.git" ]] && HAS_EXISTING=true

    if $UNATTENDED; then
        if $HAS_EXISTING; then INSTALL_MODE="reinstall"; else INSTALL_MODE="new"; fi
        return
    fi

    echo -e "  ${CYAN}Select installation type:${NC}\n"
    if $HAS_EXISTING; then
        echo -e "    ${GREEN}1)${NC} ${YELLOW}Reinstall${NC}  — Sync code repo, keep config & data"
        echo -e "    ${GREEN}2)${NC} ${RED}Fresh Install${NC} — Wipe directory completely and scratch install"
        echo -e "    ${GREEN}3)${NC} Cancel\n"
        read -rp "   Choose [1-3]: " choice
        case "$choice" in
            1) INSTALL_MODE="reinstall" ;;
            2) INSTALL_MODE="fresh" ;;
            *) err "Installation cancelled."; exit 1 ;;
        esac
    else
        echo -e "    ${GREEN}1)${NC} ${YELLOW}New Install${NC} — First time backend deployment"
        echo -e "    ${GREEN}2)${NC} Cancel\n"
        read -rp "   Choose [1-2]: " choice
        case "$choice" in
            1) INSTALL_MODE="new" ;;
            *) err "Installation cancelled."; exit 1 ;;
        esac
    fi
    echo ""
}

detect_pkg_manager() {
    if command -v apt &>/dev/null; then
        PKG_MANAGER="apt"; PKG_INSTALL="apt-get install -y"; PKG_UPDATE="apt-get update -y"
    elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf"; PKG_INSTALL="dnf install -y"; PKG_UPDATE="dnf check-update || true"
    elif command -v yum &>/dev/null; then
        PKG_MANAGER="yum"; PKG_INSTALL="yum install -y"; PKG_UPDATE="yum check-update || true"
    elif command -v zypper &>/dev/null; then
        PKG_MANAGER="zypper"; PKG_INSTALL="zypper install -y"; PKG_UPDATE="zypper refresh"
    elif command -v pacman &>/dev/null; then
        PKG_MANAGER="pacman"; PKG_INSTALL="pacman -S --noconfirm"; PKG_UPDATE="pacman -Sy"
    else
        err "No supported package manager found."; exit 1
    fi
}

install_node_if_needed() {
    local major=""
    if command -v node &>/dev/null; then
        major=$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')
    fi
    if [[ -n "$major" ]] && (( major >= 18 )); then
        ok "Node.js $(node -v) detected (>= 18) — skipping install."
        return
    fi
    if [[ -n "$major" ]]; then
        warn "Node.js v$major is too old (panel needs >= 18). Installing Node 20 LTS..."
    else
        info "Node.js not found. Installing Node 20 LTS..."
    fi

    local pid
    case "$PKG_MANAGER" in
        apt)
            mkdir -p /etc/apt/keyrings
            curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg >/dev/null 2>&1 &
            pid=$!; show_spinner "$pid" "Adding NodeSource signing key..."; wait "$pid" 2>/dev/null || true
            echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
            apt-get update -y >/dev/null 2>&1 &
            pid=$!; show_spinner "$pid" "Refreshing apt with NodeSource..."; wait "$pid" 2>/dev/null || true
            apt-get install -y nodejs >/dev/null 2>&1 &
            pid=$!; show_spinner "$pid" "Installing Node.js 20..."; wait "$pid" 2>/dev/null || true
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
            $PKG_INSTALL nodejs >/dev/null 2>&1 &
            pid=$!; show_spinner "$pid" "Installing Node.js 20..."; wait "$pid" 2>/dev/null || true
            ;;
        *)
            $PKG_INSTALL nodejs npm >/dev/null 2>&1 || true
            ;;
    esac

    if ! command -v node &>/dev/null; then
        err "Node.js could not be installed. Install Node 18+ manually and re-run."
        exit 1
    fi
    ok "Node.js $(node -v) ready."
}

install_system_deps() {
    info "Updating system package indexes..."
    local pid
    $PKG_UPDATE >/dev/null 2>&1 &
    pid=$!; show_spinner "$pid" "Refreshing package mirrors..."; wait "$pid" 2>/dev/null || true

    local packages="git curl wget ca-certificates gnupg"
    $PKG_INSTALL $packages >/dev/null 2>&1 &
    pid=$!; show_spinner "$pid" "Installing base tools ($packages)..."
    if ! wait "$pid"; then
        err "Failed to install base packages via $PKG_MANAGER."
        exit 1
    fi

    install_node_if_needed
}

install_java() {
    if $NO_JAVA; then return; fi

    if command -v java &>/dev/null; then
        local existing
        existing=$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | cut -d. -f1)
        if [[ -n "$existing" ]] && (( existing >= 17 )); then
            ok "Java $(java -version 2>&1 | head -n 1 | sed 's/.*version //;s/"//g') present (>= 17) — good to go."
            return
        fi
        warn "Java $existing detected — Minecraft 1.20+ needs Java 17+. Installing OpenJDK 21..."
    else
        info "Java not found. Installing OpenJDK 21 headless..."
    fi

    local jpid
    case "$PKG_MANAGER" in
        apt)         $PKG_INSTALL openjdk-21-jre-headless >/dev/null 2>&1 & ;;
        dnf|yum)     $PKG_INSTALL java-21-openjdk-headless >/dev/null 2>&1 & ;;
        zypper)      $PKG_INSTALL java-21-openjdk-headless >/dev/null 2>&1 & ;;
        pacman)      $PKG_INSTALL jre-openjdk-headless >/dev/null 2>&1 & ;;
        *)           $PKG_INSTALL jre21-openjdk-headless >/dev/null 2>&1 & ;;
    esac
    jpid=$!
    show_spinner "$jpid" "Installing OpenJDK 21 Headless JRE..."
    if ! wait "$jpid"; then
        err "Java installation failed."
        exit 1
    fi
    if ! command -v java &>/dev/null; then
        err "java still not on PATH after install — check the package name for $PKG_MANAGER."
        exit 1
    fi
    ok "Java ready: $(java -version 2>&1 | head -n 1)"
}

setup_project() {
    case "$INSTALL_MODE" in
        reinstall)
            cd "$PANEL_DIR" || { err "Install dir missing: $PANEL_DIR"; exit 1; }
            git config --global --add safe.directory "$PANEL_DIR" || true
            local prev
            prev=$(git rev-parse HEAD 2>/dev/null || echo "")
            git fetch --all >/dev/null 2>&1 &
            local fetchpid=$!
            show_spinner "$fetchpid" "Fetching latest changes from GitHub..."
            wait "$fetchpid" 2>/dev/null || warn "Fetch failed (network?) — continuing with local refs."
            git reset --hard "origin/$BRANCH" >/dev/null 2>&1 || { err "Reset to origin/$BRANCH failed."; exit 1; }
            # Keep runtime data (config/, .env, logs) — clean must never wipe it.
            git clean -df -e config -e .env -e logs >/dev/null 2>&1 || true
            if [[ -n "$prev" ]] && git diff --quiet "$prev" HEAD -- package.json package-lock.json 2>/dev/null; then
                NEEDS_NPM=false
                ok "Code synced — dependencies unchanged, npm install skipped."
            fi
            ;;
        new|fresh)
            # Handles both a bare fresh install and re-purposing a directory
            # that exists without being a git checkout (e.g. a failed run).
            if [[ -d "$PANEL_DIR" ]]; then
                warn "Directory exists — backing up .env and config/ before reset."
                [[ -f "$PANEL_DIR/.env" ]] && cp "$PANEL_DIR/.env" "/tmp/pmc-env-backup.$$"
                [[ -d "$PANEL_DIR/config" ]] && cp -r "$PANEL_DIR/config" "/tmp/pmc-config-backup.$$"
                rm -rf "$PANEL_DIR"
            fi
            mkdir -p "$INSTALL_DIR"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR" >/dev/null 2>&1 &
            local clonepid=$!
            show_spinner "$clonepid" "Cloning PurpleMC Panel ($BRANCH)..."
            if ! wait "$clonepid"; then
                err "Git clone failed — check network access to $REPO_URL"
                exit 1
            fi
            if [[ -f "/tmp/pmc-env-backup.$$" ]]; then cp "/tmp/pmc-env-backup.$$" "$PANEL_DIR/.env"; rm -f "/tmp/pmc-env-backup.$$"; fi
            if [[ -d "/tmp/pmc-config-backup.$$" ]]; then cp -r "/tmp/pmc-config-backup.$$" "$PANEL_DIR/config"; rm -rf "/tmp/pmc-config-backup.$$"; fi
            ;;
    esac
    cd "$PANEL_DIR"
    chmod +x update.sh install.sh 2>/dev/null || true
}

install_npm_deps() {
    cd "$PANEL_DIR"
    if ! $NEEDS_NPM; then
        info "Dependencies unchanged — skipping npm install."
        return
    fi
    info "Installing production dependencies (npm install --omit=dev)..."
    local pid
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 &
    pid=$!; show_spinner "$pid" "Installing Node modules..."
    if ! wait "$pid"; then
        err "npm install failed."
        exit 1
    fi
    ok "Node modules ready."
}

create_env() {
    if [[ ! -f "$PANEL_DIR/.env" ]]; then
        echo "PORT=$PORT" > "$PANEL_DIR/.env"
    else
        if grep -q "^PORT=" "$PANEL_DIR/.env"; then
            sed -i "s/^PORT=.*/PORT=$PORT/" "$PANEL_DIR/.env"
        else
            echo "PORT=$PORT" >> "$PANEL_DIR/.env"
        fi
    fi
}

setup_pm2() {
    if $NO_PM2; then return; fi
    if ! command -v pm2 &>/dev/null; then
        npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1 &
        local pm2pid=$!
        show_spinner "$pm2pid" "Installing global PM2 runtime..."
        wait "$pm2pid" 2>/dev/null || true
    fi
    if ! command -v pm2 &>/dev/null; then
        err "PM2 install failed — rerun with --no-pm2 or fix the npm global install."
        exit 1
    fi

    cat > "$PANEL_DIR/ecosystem.config.cjs" <<EOF
module.exports = {
    apps: [{
        name: "$PM2_NAME",
        script: "app.js",
        cwd: "$PANEL_DIR",
        env: { PORT: $PORT },
        max_memory_restart: "500M",
        log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        error_file: "$PANEL_DIR/logs/error.log",
        out_file: "$PANEL_DIR/logs/output.log",
        merge_logs: true,
    }]
};
EOF
    mkdir -p "$PANEL_DIR/logs"

    if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1
    else
        pm2 start "$PANEL_DIR/ecosystem.config.cjs" >/dev/null 2>&1
    fi
    pm2 save --silent || true
    ok "PM2 Process ecosystem verified active under identifier: '$PM2_NAME'"
}

setup_firewall() {
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
        ufw allow "$PORT/tcp" >/dev/null 2>&1 || true    # panel UI
        ufw allow 25565/tcp >/dev/null 2>&1 || true      # Minecraft server
        ufw allow 19132/udp >/dev/null 2>&1 || true      # Bedrock (Geyser)
    fi
}

print_summary() {
    local ip
    ip=$(curl -4 -s ifconfig.me || curl -4 -s icanhazip.com || echo "localhost")
    echo -e "\n${GREEN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║        Setup Finished Successfully       ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}\n"
    echo -e "  Panel UI Link:  ${CYAN}http://$ip:$PORT${NC}"
    echo -e "  Root Directory: $PANEL_DIR"
    if ! $NO_PM2; then
        echo -e "  Profile Hook:   pm2 status / pm2 logs $PM2_NAME"
    fi
    echo ""
}

# ── Main Flow Execution ──────────────────────
choose_mode
detect_pkg_manager
install_system_deps
install_java
setup_project
install_npm_deps
create_env
setup_pm2
setup_firewall
print_summary

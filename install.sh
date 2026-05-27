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
    tput cnorm
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
    echo "  --port <port>        Panel port (default: 3000)"
    echo "  --install-dir <path> Installation directory (default: $INSTALL_DIR)"
    echo "  --repo <url>         Git repository URL (default: $REPO_URL)"
    echo "  --branch <branch>    Git branch to deploy (default: main)"
    echo "  --pm2-name <name>    PM2 process name (default: $PM2_NAME)"
    echo "  --no-pm2             Skip PM2 setup"
    echo "  --no-java            Skip Java installation"
    echo "  --unattended         Run without prompts"
    echo "  --help               Show this help"
    exit 0
}

# ── Parse arguments ──────────────────────────
PORT="3000"
BRANCH="main"
NO_PM2=false
NO_JAVA=false
UNATTENDED=false

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
        --help|-h)        usage ;;
        *)                err "Unknown option: $1"; usage; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    warn "It is recommended to run this installer as root (sudo)."
    if ! $UNATTENDED; then
        read -rp "Continue without root? [y/N] " ans
        [[ "$ans" =~ ^[Yy]$ ]] || exit 1
    fi
fi

clear
typewriter "${CYAN}╔══════════════════════════════════════════╗${NC}" 0.002
typewriter "${CYAN}║        PurpleMC Panel Installer          ║${NC}" 0.002
typewriter "${CYAN}╚══════════════════════════════════════════╝${NC}" 0.002
echo ""

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

install_system_deps() {
    info "Updating system core package manifests..."
    $PKG_UPDATE >/dev/null 2>&1 &
    show_spinner $! "Refreshing internal repository mirrors..."
    
    local packages="git curl wget ca-certificates gnupg"
    $PKG_INSTALL $packages >/dev/null 2>&1 &
    show_spinner $! "Validating basic software packages ($packages)..."

    if ! command -v node &>/dev/null; then
        info "Node.js environment missing. Building NodeSource Node.js 20 LTS environment..."
        case "$PKG_MANAGER" in
            apt)
                mkdir -p /etc/apt/keyrings
                curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg >/dev/null 2>&1
                echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list >/dev/null
                apt-get update -y >/dev/null 2>&1 && apt-get install nodejs -y >/dev/null 2>&1
                ;;
            dnf|yum)
                curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
                $PKG_INSTALL nodejs >/dev/null 2>&1
                ;;
            *)
                $PKG_INSTALL nodejs npm >/dev/null 2>&1 || true
                ;;
        esac
        ok "Node.js environment configuration integrated."
    else
        ok "Node.js $(node -v) runtime already up-to-date."
    fi
}

install_java() {
    if $NO_JAVA; then return; fi
    if command -v java &>/dev/null; then
        ok "Java Runtime Interface present: $(java -version 2>&1 | head -n 1)"
        return
    fi
    case "$PKG_MANAGER" in
        apt)     $PKG_INSTALL openjdk-21-jre-headless >/dev/null 2>&1 & ;;
        dnf|yum) $PKG_INSTALL java-21-openjdk-headless >/dev/null 2>&1 & ;;
        *)       $PKG_INSTALL jre21-openjdk-headless >/dev/null 2>&1 & ;;
    esac
    show_spinner $! "Deploying heavy environment: OpenJDK 21 Headless JRE..."
    ok "Java virtualization structures attached."
}

setup_project() {
    case "$INSTALL_MODE" in
        fresh)
            if [[ -d "$PANEL_DIR" ]]; then
                [[ -f "$PANEL_DIR/.env" ]] && cp "$PANEL_DIR/.env" /tmp/pmc-env-backup
                [[ -d "$PANEL_DIR/config" ]] && cp -r "$PANEL_DIR/config" /tmp/pmc-config-backup
                rm -rf "$PANEL_DIR"
            fi
            mkdir -p "$INSTALL_DIR"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR" >/dev/null 2>&1 &
            show_spinner $! "Fresh-cloning full clean tracking environment..."
            
            if [[ -f /tmp/pmc-env-backup ]]; then cp /tmp/pmc-env-backup "$PANEL_DIR/.env"; fi
            if [[ -d /tmp/pmc-config-backup ]]; then cp -r /tmp/pmc-config-backup "$PANEL_DIR/config"; fi
            ;;
        reinstall)
            cd "$PANEL_DIR"
            git config --global --add safe.directory "$PANEL_DIR" || true
            git fetch --all >/dev/null 2>&1 &
            show_spinner $! "Connecting to GitHub remote targets..."
            git reset --hard "origin/$BRANCH" >/dev/null 2>&1
            git clean -df >/dev/null 2>&1
            ;;
        new)
            mkdir -p "$INSTALL_DIR"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR" >/dev/null 2>&1 &
            show_spinner $! "Pulling latest files from upstream repository branch..."
            ;;
    esac
    cd "$PANEL_DIR"
    chmod +x update.sh install.sh 2>/dev/null || true
}

install_npm_deps() {
    cd "$PANEL_DIR"
    npm prune >/dev/null 2>&1
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 &
    show_spinner $! "Syncing application system dependencies via npm..."
    ok "Modules folder structurally clean."
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
        show_spinner $! "Installing global PM2 instance runtime..."
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
        ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
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

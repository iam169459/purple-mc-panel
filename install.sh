#!/bin/bash
set -Eeuo pipefail

# ──────────────────────────────────────────────
# PurpleMC Panel — Linux Auto-Installer
# ──────────────────────────────────────────────

REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
INSTALL_DIR="/var/www/purple-mc-panel"
PANEL_DIR="$INSTALL_DIR/purple-panel"
PM2_NAME="purple-mc-panel"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERR]${NC} $1"; }

usage() {
    echo "Usage: $0 [options]"
    echo "Options:"
    echo "  --port <port>          Panel port (default: 3000)"
    echo "  --install-dir <path>   Installation directory (default: $INSTALL_DIR)"
    echo "  --repo <url>           Git repository URL (default: $REPO_URL)"
    echo "  --branch <branch>      Git branch to deploy (default: dev-test)"
    echo "  --pm2-name <name>      PM2 process name (default: $PM2_NAME)"
    echo "  --no-pm2               Skip PM2 setup (run via node directly)"
    echo "  --no-java              Skip Java installation"
    echo "  --unattended           Run without prompts"
    echo "  --help                 Show this help"
    exit 0
}

# ── Parse arguments ──────────────────────────
PORT="3000"
BRANCH="dev-test"
NO_PM2=false
NO_JAVA=false
UNATTENDED=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)           PORT="${2:?Missing port value}"; shift 2 ;;
        --install-dir)    INSTALL_DIR="${2:?Missing install-dir value}"; PANEL_DIR="$INSTALL_DIR/purple-panel"; shift 2 ;;
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

# ── Root check ───────────────────────────────
if [[ $EUID -ne 0 ]]; then
    warn "It is recommended to run this installer as root (sudo)."
    if ! $UNATTENDED; then
        read -rp "Continue without root? [y/N] " ans
        [[ "$ans" =~ ^[Yy]$ ]] || exit 1
    fi
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       PurpleMC Panel Installer          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Install mode selection ───────────────────
choose_mode() {
    local HAS_EXISTING=false
    [[ -d "$PANEL_DIR" ]] && HAS_EXISTING=true

    if $UNATTENDED; then
        if $HAS_EXISTING; then
            INSTALL_MODE="reinstall"
        else
            INSTALL_MODE="new"
        fi
        info "Unattended mode, install type: $INSTALL_MODE"
        return
    fi

    echo -e "  ${CYAN}Select installation type:${NC}"
    echo ""
    if $HAS_EXISTING; then
        echo -e "    ${GREEN}1)${NC} ${YELLOW}Reinstall${NC}  — Update existing installation, keep config & data"
        echo -e "    ${GREEN}2)${NC} ${RED}Fresh Install${NC} — Wipe everything and install from scratch"
        echo -e "    ${GREEN}3)${NC} Cancel"
        echo ""
        read -rp "  Choose [1-3]: " choice
        case "$choice" in
            1) INSTALL_MODE="reinstall" ;;
            2) INSTALL_MODE="fresh" ;;
            *) err "Installation cancelled."; exit 1 ;;
        esac
    else
        echo -e "    ${GREEN}1)${NC} ${YELLOW}New Install${NC} — First time setup on this system"
        echo -e "    ${GREEN}2)${NC} Cancel"
        echo ""
        read -rp "  Choose [1-2]: " choice
        case "$choice" in
            1) INSTALL_MODE="new" ;;
            *) err "Installation cancelled."; exit 1 ;;
        esac
    fi
    echo ""
    info "Selected: $INSTALL_MODE install"
    echo ""
}

# ── Detect package manager ───────────────────
detect_pkg_manager() {
    if command -v apt &>/dev/null; then
        PKG_MANAGER="apt"
        PKG_INSTALL="apt install -y"
        PKG_UPDATE="apt update -y"
    elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf"
        PKG_INSTALL="dnf install -y"
        PKG_UPDATE="dnf check-update || true"
    elif command -v yum &>/dev/null; then
        PKG_MANAGER="yum"
        PKG_INSTALL="yum install -y"
        PKG_UPDATE="yum check-update || true"
    elif command -v zypper &>/dev/null; then
        PKG_MANAGER="zypper"
        PKG_INSTALL="zypper install -y"
        PKG_UPDATE="zypper refresh"
    elif command -v pacman &>/dev/null; then
        PKG_MANAGER="pacman"
        PKG_INSTALL="pacman -S --noconfirm"
        PKG_UPDATE="pacman -Sy"
    else
        err "No supported package manager found (apt, dnf, yum, zypper, pacman)."
        exit 1
    fi
    info "Detected package manager: $PKG_MANAGER"
}

# ── Install system dependencies ──────────────
install_system_deps() {
    info "Updating package lists..."
    $PKG_UPDATE

    local packages="git curl wget"

    info "Installing base system packages: $packages"
    $PKG_INSTALL $packages

    if ! command -v node &>/dev/null; then
        info "Node.js not found. Installing..."
        case "$PKG_MANAGER" in
            apt)
                curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
                $PKG_INSTALL nodejs
                ;;
            dnf|yum)
                curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
                $PKG_INSTALL nodejs
                ;;
            zypper)
                $PKG_INSTALL nodejs20
                ;;
            pacman)
                $PKG_INSTALL nodejs npm
                ;;
        esac
    else
        ok "Node.js $(node -v) is already installed."
    fi

    if ! command -v npm &>/dev/null; then
        info "npm not found. Installing..."
        case "$PKG_MANAGER" in
            apt|dnf|yum) $PKG_INSTALL npm ;;
            pacman) $PKG_INSTALL npm ;;
            zypper) $PKG_INSTALL npm20 ;;
        esac
    else
        ok "npm $(npm -v) is already installed."
    fi
}

# ── Install Java ─────────────────────────────
install_java() {
    if $NO_JAVA; then
        info "Skipping Java installation (--no-java)."
        return
    fi
    if command -v java &>/dev/null; then
        ok "Java $(java -version 2>&1 | head -1 | grep -oP '"\K[^"]+' || java -version 2>&1 | head -1 | sed 's/.*version //;s/[^0-9.]//g') is already installed."
        return
    fi
    info "Installing Java (OpenJDK 21 JRE)..."
    case "$PKG_MANAGER" in
        apt)     $PKG_INSTALL openjdk-21-jre-headless ;;
        dnf|yum) $PKG_INSTALL java-21-openjdk-headless ;;
        zypper)  $PKG_INSTALL java-21-openjdk ;;
        pacman)  $PKG_INSTALL jre21-openjdk-headless ;;
    esac
    if command -v java &>/dev/null; then
        ok "Java installed successfully."
    else
        warn "Java installation may have failed. Install it manually."
    fi
}

# ── Clone / copy project ─────────────────────
setup_project() {
    case "$INSTALL_MODE" in
        fresh)
            warn "Fresh install: wiping $PANEL_DIR..."
            if [[ -d "$PANEL_DIR" ]]; then
                # Backup config if present
                if [[ -f "$PANEL_DIR/.env" ]]; then
                    cp "$PANEL_DIR/.env" /tmp/pmc-env-backup
                    info "Backed up .env to /tmp/pmc-env-backup"
                fi
                if [[ -d "$PANEL_DIR/config" ]]; then
                    cp -r "$PANEL_DIR/config" /tmp/pmc-config-backup
                    info "Backed up config/ to /tmp/pmc-config-backup"
                fi
                rm -rf "$PANEL_DIR"
            fi
            info "Cloning repository (branch: $BRANCH) into $PANEL_DIR..."
            mkdir -p "$INSTALL_DIR"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR"
            # Restore config backups
            if [[ -f /tmp/pmc-env-backup ]]; then
                cp /tmp/pmc-env-backup "$PANEL_DIR/.env"
                ok "Restored .env from backup."
            fi
            if [[ -d /tmp/pmc-config-backup ]]; then
                cp -r /tmp/pmc-config-backup "$PANEL_DIR/config"
                ok "Restored config/ from backup."
            fi
            ;;
        reinstall)
            info "Reinstalling: updating existing code..."
            cd "$PANEL_DIR"
            # Only add safe.directory if not already present
            if ! git config --global --get-all safe.directory | grep -qxF "$PANEL_DIR"; then
                git config --global --add safe.directory "$PANEL_DIR" || true
            fi
            # Stash any local changes to avoid conflicts
            STASH_REF=$(git stash --include-untracked 2>/dev/null || true)
            git fetch --all --tags 2>/dev/null || git fetch origin "$BRANCH" --depth 1
            git reset --hard "origin/$BRANCH"
            # Pop stash if changes were saved
            if [ -n "$STASH_REF" ]; then
                git stash pop 2>/dev/null || true
            fi
            ok "Code updated to latest origin/$BRANCH."
            ;;
        new)
            info "New installation: cloning repository (branch: $BRANCH)..."
            mkdir -p "$INSTALL_DIR"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR"
            ;;
    esac

    cd "$PANEL_DIR"
    chmod +x update.sh 2>/dev/null || true
}

# ── Install npm dependencies ─────────────────
install_npm_deps() {
    info "Installing npm production dependencies..."
    cd "$PANEL_DIR"
    npm install --omit=dev --no-audit --no-fund
    ok "npm dependencies installed."
}

# ── Create .env with port ────────────────────
create_env() {
    if [[ ! -f "$PANEL_DIR/.env" ]]; then
        echo "PORT=$PORT" > "$PANEL_DIR/.env"
        info "Created .env with PORT=$PORT."
    else
        if grep -q "^PORT=" "$PANEL_DIR/.env"; then
            sed -i "s/^PORT=.*/PORT=$PORT/" "$PANEL_DIR/.env"
        else
            echo "PORT=$PORT" >> "$PANEL_DIR/.env"
        fi
        ok ".env updated."
    fi
}

# ── PM2 setup ────────────────────────────────
setup_pm2() {
    if $NO_PM2; then
        info "Skipping PM2 setup (--no-pm2)."
        info "Run the panel manually with: node $PANEL_DIR/app.js"
        return
    fi

    if ! command -v pm2 &>/dev/null; then
        info "Installing PM2 globally..."
        npm install -g pm2 --no-audit --no-fund
    else
        ok "PM2 is already installed."
    fi

    # Create PM2 ecosystem file
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
        pm2 restart "$PM2_NAME" --update-env
    else
        pm2 start "$PANEL_DIR/ecosystem.config.cjs"
    fi

    pm2 save
    ok "PM2 process '$PM2_NAME' started and saved."

    # PM2 startup hook
    info "Configuring PM2 to start on system boot..."
    if pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup 2>/dev/null; then
        ok "PM2 startup hook configured."
    else
        warn "PM2 startup hook could not be configured. You may need to run it manually."
    fi
}

# ── Firewall ─────────────────────────────────
setup_firewall() {
    if command -v ufw &>/dev/null; then
        if ufw status 2>/dev/null | grep -q "active"; then
            if ! ufw status 2>/dev/null | grep -q "$PORT/tcp"; then
                info "Opening port $PORT in UFW..."
                ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
                ok "UFW rule added for port $PORT."
            else
                ok "UFW rule for port $PORT already exists."
            fi
        fi
    elif command -v firewall-cmd &>/dev/null; then
        if firewall-cmd --state 2>/dev/null | grep -q "running"; then
            if ! firewall-cmd --list-ports 2>/dev/null | grep -q "$PORT/tcp"; then
                info "Opening port $PORT in firewalld..."
                firewall-cmd --zone=public --add-port="$PORT/tcp" --permanent >/dev/null 2>&1 || true
                firewall-cmd --reload >/dev/null 2>&1 || true
                ok "Firewalld rule added for port $PORT."
            else
                ok "Firewalld rule for port $PORT already exists."
            fi
        fi
    fi
}

# ── Print summary ────────────────────────────
print_summary() {
    local ip
    ip=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || echo "your-server-ip")

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║       Installation Complete!            ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Panel URL:      ${CYAN}http://$ip:$PORT${NC}"
    echo -e "  Install dir:    $PANEL_DIR"
    echo ""
    if ! $NO_PM2; then
        echo -e "  PM2 name:       $PM2_NAME"
        echo -e "  PM2 commands:"
        echo -e "    pm2 status              — view process status"
        echo -e "    pm2 logs $PM2_NAME      — view logs"
        echo -e "    pm2 restart $PM2_NAME   — restart panel"
        echo -e "    pm2 stop $PM2_NAME      — stop panel"
        echo ""
    fi
    echo -e "  ${YELLOW}Make sure port $PORT is accessible from your firewall.${NC}"
    echo ""
}

# ═══════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════

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

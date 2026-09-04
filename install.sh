#!/usr/bin/env bash
# ============================================================
# PurpleMC Panel — Unified Manager (install / update / run)
# Single script replacing the old install.sh + update.sh pair.
#
#   ./install.sh                  interactive menu (TTY)
#   ./install.sh install [flags]  new or reinstall (auto-detected)
#   ./install.sh update           sync code from GitHub — choose main or dev
#   ./install.sh update-dev       sync code from the dev branch (latest features)
#   ./install.sh status|start|stop|restart|logs|uninstall
#
# Flags (all commands): --port --install-dir --repo --branch
#   --pm2-name --no-pm2 --no-java --no-autostart --unattended --help
# ============================================================

set -Eeuo pipefail

SCRIPT_VERSION="1.4.0"
REPO_URL="https://github.com/iam169459/purple-mc-panel.git"
INSTALL_DIR="/var/www/purple-mc-panel"
PANEL_DIR="$INSTALL_DIR"
PM2_NAME="purple-mc-panel"
PORT="3000"
BRANCH="main"
BRANCH_SET=false
NO_PM2=false
NO_JAVA=false
NO_AUTOSTART=false
UNATTENDED=false
NEEDS_NPM=true
INSTALL_DIR_SET=false

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; CYAN=$'\033[0;36m'; MAGENTA=$'\033[0;35m'; NC=$'\033[0m'

cleanup() { tput cnorm 2>/dev/null || true; }
trap cleanup EXIT INT TERM
trap 'err "Script failed at line $LINENO: $BASH_COMMAND"; exit 1' ERR

info()   { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()     { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()    { echo -e "${RED}[ERR ]${NC} $1"; }
hr()     { echo -e "${CYAN}──────────────────────────────────────────────────────${NC}"; }

typewriter() {
    local text="$1"
    echo -e "$text"
}

show_spinner() {
    local pid=$1 message=$2 delay=0.07
    local -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local idx=0
    tput civis 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r${CYAN}[%s]${NC} %s" "${frames[$idx]}" "$message"
        idx=$(( (idx + 1) % ${#frames[@]} ))
        sleep "$delay"
    done
    printf "\r\033[K"
    tput cnorm 2>/dev/null || true
}

step() { echo -e "\n${MAGENTA}──${NC} ${YELLOW}Step $1/${2}${NC} — ${CYAN}$3${NC}"; }

usage() {
    echo "PurpleMC Panel Manager v$SCRIPT_VERSION"
    echo "Usage: $0 [action] [options]"
    echo ""
    echo "Actions:"
    echo "  (none)            Interactive menu"
    echo "  setup             Guided full setup on a brand-new server/PC (from zero)"
    echo "  install           Install or reinstall the panel (auto-detects existing install)"
    echo "  update            Sync panel code from GitHub — choose main or dev (keeps data)"
    echo "  update-dev        Sync panel code from the dev branch (latest features)"
    echo "  fresh             Wipe the install directory and install from scratch"
    echo "  start | stop | restart   Control the PM2 service"
    echo "  status            Show service and code status"
    echo "  logs              Tail PM2 logs"
    echo "  uninstall         Remove the service and install directory"
    echo ""
    echo "Options:"
    echo "  --port <port>        Panel port (default: 3000, 1-65535)"
    echo "  --install-dir <path> Panel directory (default: $INSTALL_DIR)"
    echo "  --repo <url>         Git repository URL (default: $REPO_URL)"
    echo "  --branch <branch>    Git branch to deploy (default: main)"
    echo "  --pm2-name <name>    PM2 process name (default: $PM2_NAME)"
    echo "  --no-pm2             Skip PM2 setup"
    echo "  --no-java            Skip Java installation"
    echo "  --no-autostart       Skip boot autostart (pm2 startup + Minecraft auto-start)"
    echo "  --unattended         No prompts (requires root for install/fresh/uninstall)"
    echo "  --help, -h           Show this help"
    echo ""
    echo "Examples:"
    echo "  sudo $0 --unattended --port 8080          # one-shot install"
    echo "  $0 update                                  # update an existing panel (main or dev)"
    echo "  $0 update-dev                              # pull the latest dev build"
    echo "  $0 status"
}

# ── prompt/confirm helpers (work even when piped via curl) ──
prompt() { # $1 = question, $2 = default
    local ans
    if [[ -t 0 ]]; then read -rp "$1 " ans
    elif [[ -e /dev/tty ]]; then read -rp "$1 " ans < /dev/tty
    else echo "$2"; return 0; fi
    [[ -n "$ans" ]] && echo "$ans" || echo "$2"
}
confirm() { # $1 = question
    local ans
    ans=$(prompt "$1 [y/N]" "n")
    [[ "$ans" =~ ^[Yy]$ ]]
}

# True when the current working directory is $1 or anything inside it
# (resolves symlinks — /tmp on macOS is a link to /private/tmp).
cwd_inside() {
    local cwd_p dir_p
    cwd_p="$(pwd -P)"
    if [[ -d "$1" ]]; then dir_p="$(cd "$1" 2>/dev/null && pwd -P)" || dir_p="$1"; else dir_p="$1"; fi
    [[ "$cwd_p" == "$dir_p" || "$cwd_p" == "$dir_p/"* ]]
}

banner() {
    if [[ -t 1 ]] && ! $UNATTENDED; then
        clear 2>/dev/null || true
        typewriter "${CYAN}╔══════════════════════════════════════════════╗${NC}" 0.002
        typewriter "${CYAN}║      PurpleMC Panel Manager  v${SCRIPT_VERSION}      ║${NC}" 0.002
        typewriter "${CYAN}╚══════════════════════════════════════════════╝${NC}" 0.002
        echo ""
    else
        echo -e "${CYAN} PurpleMC Panel Manager v${SCRIPT_VERSION} ${NC}"
    fi
}

# ── environment detection ──
detect_pkg_manager() {
    if command -v apt &>/dev/null; then
        PKG_MANAGER="apt";     PKG_INSTALL="apt-get install -y";   PKG_UPDATE="apt-get update -y"
    elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf";     PKG_INSTALL="dnf install -y";       PKG_UPDATE="dnf check-update || true"
    elif command -v yum &>/dev/null; then
        PKG_MANAGER="yum";     PKG_INSTALL="yum install -y";       PKG_UPDATE="yum check-update || true"
    elif command -v zypper &>/dev/null; then
        PKG_MANAGER="zypper";  PKG_INSTALL="zypper install -y";    PKG_UPDATE="zypper refresh"
    elif command -v pacman &>/dev/null; then
        PKG_MANAGER="pacman"; PKG_INSTALL="pacman -S --noconfirm"; PKG_UPDATE="pacman -Sy"
    elif command -v brew &>/dev/null; then
        PKG_MANAGER="brew"; PKG_INSTALL="brew install"; PKG_UPDATE="brew update"
    else
        err "No supported package manager found (apt/dnf/yum/zypper/pacman, or Homebrew on macOS)."
        exit 1
    fi
}

detect_os() {
    local os_name
    os_name="$(uname -s)"
    case "$os_name" in
        Linux)  info "OS: Linux detected." ;;
        Darwin)
            info "OS: macOS detected."
            command -v brew &>/dev/null || { err "macOS setup needs Homebrew — install it from https://brew.sh and re-run."; exit 1; }
            ;;
        *)
            err "Unsupported OS: $os_name"
            err "On Windows, run this inside WSL2 (Ubuntu) or use a Linux server/VM."
            exit 1
            ;;
    esac
}

require_root() {
    if [[ $EUID -ne 0 ]]; then
        err "This action needs root privileges. Re-run with: sudo $0 $*"
        exit 1
    fi
}

find_panel_dir() { # explicit --install-dir wins, else cwd when it's a clone, else default
    if $INSTALL_DIR_SET; then PANEL_DIR="$INSTALL_DIR";
    elif [[ -d .git ]] && [[ -f app.js ]]; then PANEL_DIR="$(pwd)";
    else PANEL_DIR="$INSTALL_DIR"; fi
    # Remember the branch chosen by a previous install/update so later updates
    # keep tracking it (e.g. a dev preview) unless --branch overrides it.
    if ! $BRANCH_SET && [[ -f "$PANEL_DIR/.env" ]]; then
        local env_branch
        env_branch=$(grep -E '^BRANCH=' "$PANEL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true)
        [[ -n "$env_branch" ]] && BRANCH="$env_branch"
    fi
}

pm2_cmd() {
    if ! command -v pm2 &>/dev/null; then
        err "PM2 is not installed (or not on PATH for this user)."
        return 1
    fi
    pm2 "$@"
}

# ════════════════════════════════════════════════════════════
# INSTALL FLOW
# ════════════════════════════════════════════════════════════

choose_mode() {
    local has_git=false
    [[ -d "$PANEL_DIR/.git" ]] && has_git=true

    if $UNATTENDED || [[ ! -t 0 && ! -e /dev/tty ]]; then
        if $has_git; then INSTALL_MODE="reinstall"; else INSTALL_MODE="new"; fi
        return
    fi

    hr
    echo -e "  ${CYAN}Where should the panel go?${NC}\n"
    echo -e "    Directory : ${YELLOW}$PANEL_DIR${NC}"
    if $has_git; then
        echo -e "    Existing  : ${GREEN}git install found${NC}\n"
        echo -e "  ${GREEN}1)${NC} Reinstall     — sync latest code, keep config/worlds/backups"
        echo -e "  ${GREEN}2)${NC} Fresh Install — wipe directory, scratch install"
        echo -e "  ${GREEN}3)${NC} Cancel"
    else
        echo -e "  ${GREEN}1)${NC} New Install   — first-time deployment"
        echo -e "  ${GREEN}2)${NC} Cancel"
    fi
    local choice
    choice=$(prompt "Choose:" "1")
    case "$choice" in
        1) $has_git && INSTALL_MODE="reinstall" || INSTALL_MODE="new" ;;
        2) if $has_git; then INSTALL_MODE="fresh"; else err "Cancelled."; exit 1; fi ;;
        *) err "Cancelled."; exit 1 ;;
    esac
}

# Run a package-manager command with a spinner, capturing output to a log so
# failures always show the real package-manager error instead of a bare "failed".
pkg_run() { # <label> then command words...
    local label="$1"; shift
    local logfile rc pid
    logfile="$(mktemp /tmp/pmc-pkg-XXXXXX.log)"
    "$@" >"$logfile" 2>&1 &
    pid=$!
    show_spinner "$pid" "$label"
    wait "$pid" && rc=0 || rc=$?
    if (( rc != 0 )); then
        warn "'$*' failed (exit $rc) — output tail:"
        tail -n 8 "$logfile" | sed 's/^/    /'
    fi
    rm -f "$logfile"
    return "$rc"
}

install_system_deps() {
    step 1 6 "System packages"
    if ! pkg_run "Refreshing package mirrors..." $PKG_UPDATE; then
        warn "Package index update had problems — continuing anyway."
    fi
    if ! pkg_run "Installing base tools (git, curl, ...)" $PKG_INSTALL git curl wget ca-certificates gnupg; then
        err "Failed to install base packages — see the error above."
        exit 1
    fi
    ok "Base tools ready."
    install_node_if_needed
}

install_node_if_needed() {
    local major=""
    if command -v node &>/dev/null; then major=$(node -v 2>/dev/null | sed 's/^v//;s/\..*//'); fi
    if [[ -n "$major" ]] && (( major >= 18 )); then
        ok "Node.js $(node -v) detected (>= 18)."
        return
    fi
    [[ -n "$major" ]] && warn "Node.js v$major too old (needs >= 18) — installing Node 20 LTS..." \
                      || info "Node.js not found — installing Node 20 LTS..."
    case "$PKG_MANAGER" in
        apt)
            mkdir -p /etc/apt/keyrings
            pkg_run "Adding NodeSource signing key..." bash -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg" || true
            echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
            pkg_run "Refreshing apt (NodeSource)..." apt-get update -y || true
            pkg_run "Installing Node.js 20..." apt-get install -y nodejs || true
            ;;
        dnf|yum)
            pkg_run "Adding NodeSource repository..." bash -c "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -" || true
            pkg_run "Installing Node.js 20..." $PKG_INSTALL nodejs || true
            ;;
        brew)
            pkg_run "Installing Node.js via Homebrew..." brew install node || true
            ;;
        *)  $PKG_INSTALL nodejs npm >/dev/null 2>&1 || true ;;
    esac
    command -v node &>/dev/null || { err "Node.js install failed — install Node 18+ manually and re-run."; exit 1; }
    ok "Node.js $(node -v) ready."
}

install_java() {
    if $NO_JAVA; then return; fi
    local existing=""
    if command -v java &>/dev/null; then
        existing=$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | cut -d. -f1)
        if [[ -n "$existing" ]] && (( existing >= 17 )); then
            ok "Java $(java -version 2>&1 | head -n1 | sed 's/.*version //;s/"//g') present (>= 17) — good to go."
            return
        fi
        [[ -n "$existing" ]] && warn "Java $existing is too old for modern Minecraft (needs 17+). Upgrading..."
    else
        info "Java not found — installing a compatible JRE..."
    fi

    # Try the newest package first, then fall back. Distros like Ubuntu 22.04
    # and Debian 12 only ship OpenJDK 17, which Paper still supports fine.
    local candidates=()
    case "$PKG_MANAGER" in
        apt)      candidates=(openjdk-21-jre-headless openjdk-17-jre-headless) ;;
        dnf|yum)  candidates=(java-21-openjdk-headless java-17-openjdk-headless) ;;
        zypper)   candidates=(java-21-openjdk-headless java-17-openjdk-headless) ;;
        pacman)   candidates=(jre-openjdk-headless) ;;
        brew)     candidates=(openjdk@21 openjdk@17 openjdk) ;;
        *)        candidates=(jre21-openjdk-headless openjdk-17-jre-headless) ;;
    esac

    local pkg installed_any=false
    for pkg in "${candidates[@]}"; do
        info "Trying: $pkg"
        if pkg_run "Installing $pkg..." $PKG_INSTALL "$pkg"; then
            installed_any=true
            command -v java &>/dev/null && break
        fi
    done

    # Homebrew installs are keg-only — put the JRE on PATH for this script
    # (and any process it spawns) so 'java' resolves without extra config.
    if [[ "$PKG_MANAGER" == "brew" ]] && ! command -v java &>/dev/null; then
        local brewopt d
        brewopt="$(brew --prefix 2>/dev/null)/opt"
        for d in openjdk@21 openjdk@17 openjdk; do
            if [[ -x "$brewopt/$d/bin/java" ]]; then
                export PATH="$brewopt/$d/bin:$PATH"
                export JAVA_HOME="$brewopt/$d/libexec/openjdk.jdk/Contents/Home"
                break
            fi
        done
    fi

    if command -v java &>/dev/null; then
        ok "Java ready: $(java -version 2>&1 | head -n1)"
    elif $installed_any; then
        warn "A JRE was installed, but 'java' is not on PATH. Fix with: update-alternatives --config java"
    else
        err "Java installation failed — every candidate package was rejected (details above)."
        err "Install Java 17+ manually, e.g. 'sudo apt-get install openjdk-17-jre-headless', then re-run."
        exit 1
    fi
}

fetch_code() { # new|fresh|reinstall handled here; fresh==new are identical except menu naming
    step 2 6 "Panel code"
    case "$INSTALL_MODE" in
        reinstall)
            cd "$PANEL_DIR" || { err "Install dir missing: $PANEL_DIR"; exit 1; }
            git config --global --add safe.directory "$PANEL_DIR" || true
            local prev
            prev=$(git rev-parse HEAD 2>/dev/null || echo "")
            git fetch --all >/dev/null 2>&1 &
            local fp=$!
            show_spinner "$fp" "Fetching latest changes from GitHub..."
            wait "$fp" 2>/dev/null || warn "Fetch failed (network?) — continuing with local refs."
            git reset --hard "origin/$BRANCH" >/dev/null 2>&1 || { err "Reset to origin/$BRANCH failed."; exit 1; }
            git clean -df -e config -e .env -e logs >/dev/null 2>&1 || true
            if [[ -n "$prev" ]] && git diff --quiet "$prev" HEAD -- package.json package-lock.json 2>/dev/null; then
                NEEDS_NPM=false
            fi
            ok "Code synced to origin/$BRANCH ($(git rev-parse --short HEAD))."
            ;;
        new|fresh)
            # Never wipe a directory the caller's shell is inside: a deleted
            # cwd breaks every child process (e.g. git clone can't resolve
            # the working directory). Step out of it first.
            if cwd_inside "$PANEL_DIR"; then
                warn "Running from inside the install directory — switching to / before resetting it."
                cd /
                RAN_FROM_TARGET=1
            fi
            if [[ -d "$PANEL_DIR" ]]; then
                warn "Directory exists — backing up .env and config/ first."
                [[ -f "$PANEL_DIR/.env" ]] && cp "$PANEL_DIR/.env" "/tmp/pmc-env.$$"
                [[ -d "$PANEL_DIR/config" ]] && cp -r "$PANEL_DIR/config" "/tmp/pmc-config.$$"
                rm -rf "$PANEL_DIR"
            fi
            mkdir -p "$INSTALL_DIR"
            local clog cp
            clog="$(mktemp /tmp/pmc-clone-XXXXXX.log)"
            git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PANEL_DIR" >"$clog" 2>&1 &
            cp=$!
            show_spinner "$cp" "Cloning PurpleMC Panel ($BRANCH)..."
            if ! wait "$cp"; then
                err "Clone failed — git output tail:"
                tail -n 10 "$clog" | sed 's/^/    /'
                err "Check network access to $REPO_URL and re-run."
                exit 1
            fi
            rm -f "$clog"
            if [[ -f "/tmp/pmc-env.$$" ]]; then cp "/tmp/pmc-env.$$" "$PANEL_DIR/.env"; rm -f "/tmp/pmc-env.$$"; fi
            if [[ -d "/tmp/pmc-config.$$" ]]; then cp -r "/tmp/pmc-config.$$" "$PANEL_DIR/config"; rm -rf "/tmp/pmc-config.$$"; fi
            ok "Panel cloned into $PANEL_DIR."
            ;;
    esac
    cd "$PANEL_DIR"
    chmod +x install.sh 2>/dev/null || true
}

install_npm_deps() {
    step 3 6 "Node modules"
    cd "$PANEL_DIR"
    if ! $NEEDS_NPM; then
        info "Dependencies unchanged — skipping npm install."
        return
    fi
    local nver nver_npm
    nver=$(node -v 2>/dev/null || echo "MISSING")
    nver_npm=$(npm -v 2>/dev/null || echo "MISSING")
    info "Node $nver · npm $nver_npm"
    local logfile pid
    logfile="$(mktemp /tmp/pmc-npm-XXXXXX.log)"
    npm install --omit=dev --no-audit --no-fund >"$logfile" 2>&1 &
    pid=$!; show_spinner "$pid" "Installing Node modules..."
    if ! wait "$pid"; then
        err "npm install failed — output tail:"
        tail -n 12 "$logfile" | sed 's/^/    /'
        err "Diagnose manually: cd $PANEL_DIR && npm install"
        exit 1
    fi
    rm -f "$logfile"
    ok "Node modules ready."
}

write_env_and_ecosystem() {
    step 5 7 "Configuration"
    if [[ ! -f "$PANEL_DIR/.env" ]]; then
        echo "PORT=$PORT" > "$PANEL_DIR/.env"
    elif grep -q "^PORT=" "$PANEL_DIR/.env"; then
        sed -i "s/^PORT=.*/PORT=$PORT/" "$PANEL_DIR/.env"
    else
        echo "PORT=$PORT" >> "$PANEL_DIR/.env"
    fi
    mkdir -p "$PANEL_DIR/logs"

    # Remember which branch this install tracks so future updates keep using it.
    if grep -q "^BRANCH=" "$PANEL_DIR/.env"; then
        sed -i "s|^BRANCH=.*|BRANCH=$BRANCH|" "$PANEL_DIR/.env"
    else
        echo "BRANCH=$BRANCH" >> "$PANEL_DIR/.env"
    fi

    if $NO_PM2; then
        ok ".env written (PORT=$PORT). Skipping PM2 (--no-pm2)."
        return
    fi

    cat > "$PANEL_DIR/ecosystem.config.cjs" <<EOF
module.exports = {
    apps: [{
        name: "$PM2_NAME",
        script: "app.js",
        cwd: "$PANEL_DIR",
        env: { PORT: $PORT },
        // Auto-restart the panel if it crashes — with a short delay and
        // exponential back-off so a crash-loop can't hammer the machine.
        autorestart: true,
        restart_delay: 1000,
        exp_backoff_restart_delay: 100,
        max_memory_restart: "500M",
        // Grace period for app.js to stop the Minecraft server (world save)
        // before PM2 escalates to SIGKILL on stop/restart/reboot.
        kill_timeout: 30000,
        log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        error_file: "$PANEL_DIR/logs/error.log",
        out_file: "$PANEL_DIR/logs/output.log",
        merge_logs: true,
    }]
};
EOF
    ok "ecosystem.config.cjs written."
}

# Flip the panel's "auto-start Minecraft server" setting so the whole stack
# (machine boot → PM2 → panel → Minecraft server) comes back by itself after
# a reboot or power cut. Only touched on brand-new installs — an existing
# config/settings.json keeps whatever the owner chose in the panel UI.
enable_mc_autostart() {
    if $NO_PM2 || $NO_AUTOSTART || [[ "$INSTALL_MODE" == "reinstall" ]]; then return; fi
    local sf="$PANEL_DIR/config/settings.json"
    mkdir -p "$PANEL_DIR/config"
    if [[ -f "$sf" ]]; then
        if grep -q '"autoStart"' "$sf"; then
            info "config/settings.json present — keeping its autoStart preference."
        elif node -e '
                const fs = require("fs");
                const p = process.argv[1];
                try {
                    const j = JSON.parse(fs.readFileSync(p, "utf8"));
                    if (typeof j.autoStart === "undefined") {
                        j.autoStart = true;
                        fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
                    }
                } catch (e) { process.exit(1); }
            ' "$sf" 2>/dev/null; then
            ok "Enabled Minecraft auto-start in config/settings.json (kept other settings)."
        else
            warn "Could not enable Minecraft auto-start — turn it on in the panel's Settings."
        fi
    else
        printf '{\n  "autoStart": true\n}\n' > "$sf"
        ok "Minecraft server will auto-start with the panel (after boot, restart, or crash recovery)."
    fi
}

# Register PM2 with the init system so the panel comes back on its own after
# a machine reboot/power cycle (pm2 startup + pm2 save). systemd is detected
# automatically; where that is unavailable (containers, WSL, SysV hosts),
# fall back to an @reboot crontab entry that runs 'pm2 resurrect'.
pm2_boot_autostart() {
    if $NO_PM2 || $NO_AUTOSTART; then return; fi
    info "Enabling boot autostart (panel starts automatically when the machine powers on)..."
    local out rc=0
    out=$(pm2 startup 2>&1) || rc=$?
    if (( rc == 0 )); then
        ok "PM2 registered with the init system — panel will start on boot."
    elif [[ "$(uname -s)" == "Linux" ]] && command -v crontab &>/dev/null; then
        # No (or non-rooted) systemd — keep PM2 alive across reboots via cron.
        local pm2_bin pm2_dir line
        pm2_bin="$(command -v pm2)"
        pm2_dir="$(dirname "$pm2_bin")"
        line="@reboot env PATH=\"$pm2_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\" PM2_HOME=\"${PM2_HOME:-$HOME/.pm2}\" $pm2_bin resurrect >>/var/log/pm2-resurrect.log 2>&1"
        if crontab -l 2>/dev/null | grep -qF "pm2 resurrect"; then
            ok "Boot autostart already present in crontab (@reboot pm2 resurrect)."
        elif ( crontab -l 2>/dev/null | grep -vF "pm2 resurrect"; echo "$line" ) | crontab - 2>/dev/null; then
            ok "Boot autostart registered via @reboot crontab (no systemd detected)."
        else
            warn "Could not register boot autostart — run 'pm2 startup' manually after install."
        fi
    else
        warn "pm2 startup could not auto-register (common in containers/WSL/macOS)."
        warn "Finish it manually with: pm2 startup   (then run the command it prints)"
    fi
    pm2 save --silent || true
}

setup_pm2() {
    step 6 7 "Service"
    if $NO_PM2; then return; fi
    if ! command -v pm2 &>/dev/null; then
        info "Installing PM2 globally..."
        local pid
        npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1 &
        pid=$!; show_spinner "$pid" "Installing PM2..."; wait "$pid" 2>/dev/null || true
    fi
    command -v pm2 &>/dev/null || { err "PM2 install failed — rerun with --no-pm2."; exit 1; }

    if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        if ! pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1; then
            pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
            pm2 start "$PANEL_DIR/ecosystem.config.cjs" >/dev/null 2>&1 || true
        fi
    else
        pm2 start "$PANEL_DIR/ecosystem.config.cjs" >/dev/null 2>&1 || true
    fi
    pm2 save --silent || true
    pm2_boot_autostart
    ok "Service '$PM2_NAME' is running (PM2)."
}

open_firewall() {
    step 7 7 "Firewall"
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
        ufw allow "$PORT/tcp"   >/dev/null 2>&1 || true
        ufw allow 25565/tcp     >/dev/null 2>&1 || true
        ufw allow 19132/udp     >/dev/null 2>&1 || true
        ok "ufw opened: $PORT/tcp, 25565/tcp, 19132/udp."
    else
        ok "No active ufw — skipping firewall rules."
    fi
}

cmd_install() {
    banner
    require_root "$ACTION ${ARGS:-}"
    find_panel_dir
    choose_mode
    run_install_stages
}

build_panel() {
    step 4 7 "Build panel"
    cd "$PANEL_DIR"
    local logfile pid
    logfile="$(mktemp /tmp/pmc-build-XXXXXX.log)"
    npm run build >"$logfile" 2>&1 &
    pid=$!; show_spinner "$pid" "Building TypeScript + React client..."
    if ! wait "$pid"; then
        err "Build failed — output tail:"
        tail -n 15 "$logfile" | sed 's/^/    /'
        err "Diagnose manually: cd $PANEL_DIR && npm run build"
        exit 1
    fi
    rm -f "$logfile"
    ok "Panel built successfully."
}

run_install_stages() {
    detect_pkg_manager
    [[ "$INSTALL_MODE" == "reinstall" ]] || install_system_deps
    install_java
    fetch_code
    install_npm_deps
    build_panel
    write_env_and_ecosystem
    enable_mc_autostart
    setup_pm2
    open_firewall
    summary
}

# ── NEW SERVER / PC — guided first-time setup ──
wizard_prompts() {
    if $UNATTENDED || [[ ! -t 0 && ! -e /dev/tty ]]; then
        local pm2_state autostart_state
        $NO_PM2 && pm2_state="off" || pm2_state="on"
        $NO_AUTOSTART && autostart_state="off" || autostart_state="on"
        info "Unattended mode — using defaults (dir=$PANEL_DIR, port=$PORT, pm2=$pm2_state, boot-autostart=$autostart_state)."
        return
    fi
    info "First-time setup wizard — press Enter to accept the default."
    echo ""
    local ans
    ans=$(prompt "Install directory [${PANEL_DIR}]:" "$PANEL_DIR");           INSTALL_DIR="$ans"; PANEL_DIR="$ans"
    ans=$(prompt "Panel HTTP port [${PORT}]:" "$PORT");                       PORT="$ans"
    ans=$(prompt "Git branch to deploy [${BRANCH}]:" "$BRANCH");             BRANCH="$ans"
    ans=$(prompt "Manage with PM2? [Y/n]:" "y");
    if [[ "$ans" =~ ^[Nn] ]]; then NO_PM2=true; else
        ans=$(prompt "PM2 process name [${PM2_NAME}]:" "$PM2_NAME");         PM2_NAME="$ans"
    fi
    if ! $NO_PM2; then
        ans=$(prompt "Auto-start the panel and Minecraft server whenever the machine powers on? [Y/n]:" "y")
        [[ "$ans" =~ ^[Nn] ]] && NO_AUTOSTART=true
    fi
    ans=$(prompt "Install Java 17+ (needed for Minecraft)? [Y/n]:" "y");
    [[ "$ans" =~ ^[Nn] ]] && NO_JAVA=true

    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
        err "Invalid port: $PORT (expected 1-65535)"
        exit 1
    fi
    echo ""
}

cmd_setup() {
    banner
    require_root "setup ${ARGS:-}"
    detect_os
    find_panel_dir
    wizard_prompts

    # A truly new server/PC: the target directory must be empty or absent,
    # or the user must explicitly confirm wiping whatever is there.
    if [[ -d "$PANEL_DIR" ]] && [[ -n "$(ls -A "$PANEL_DIR" 2>/dev/null)" ]]; then
        if $UNATTENDED; then
            err "$PANEL_DIR exists and is not empty — refusing to wipe it unattended."
            err "Point --install-dir at an empty location, or run 'fresh' with confirmation."
            exit 1
        fi
        warn "$PANEL_DIR already exists and is not empty."
        if ! confirm "Wipe it for a fresh first-time install?"; then
            err "Cancelled — nothing was changed."
            exit 1
        fi
        INSTALL_MODE="fresh"
    else
        INSTALL_MODE="new"
    fi

    info "Starting full setup on $PANEL_DIR ..."
    echo ""
    run_install_stages
    ok "Your new PurpleMC Panel is ready — open the panel URL from the summary above."
    if [[ -n "${RAN_FROM_TARGET:-}" ]]; then
        info "Your terminal was inside the old install dir — run: cd $PANEL_DIR"
    fi
}

# ════════════════════════════════════════════════════════════
# UPDATE / SERVICE / MISC
# ════════════════════════════════════════════════════════════

choose_update_branch() { # interactive: which branch should the update pull from?
    if [[ ! -t 0 && ! -e /dev/tty ]]; then return; fi
    local def=1
    [[ "$BRANCH" == "dev" ]] && def=2
    echo ""
    hr
    echo -e "  ${CYAN}Update from which branch?${NC}"
    echo -e "    ${GREEN}1)${NC} main — stable release"
    echo -e "    ${GREEN}2)${NC} dev  — latest features (may be experimental)"
    echo ""
    local choice
    choice=$(prompt "Choose [1-2]:" "$def")
    case "$choice" in
        1) BRANCH="main" ;;
        2) BRANCH="dev" ;;
        *) err "Cancelled."; exit 1 ;;
    esac
    info "Updating from branch: $BRANCH"
}

require_git_panel() {
    if [[ ! -d "$PANEL_DIR/.git" ]]; then
        err "No git install found at $PANEL_DIR — nothing to update here."
        info "Run 'sudo $0 install' instead, or point --install-dir at the panel folder."
        exit 1
    fi
}

update_flow() { # shared by 'update' and 'update-dev' (git check + INSTALL_MODE done by caller)
    [[ $EUID -ne 0 ]] && warn "Not root — npm and PM2 steps may fail if the panel is root-owned."
    fetch_code
    install_npm_deps
    build_panel
    write_env_and_ecosystem
    if ! $NO_PM2; then
        if command -v pm2 &>/dev/null; then
            pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 \
                && ok "Panel restarted under PM2 ('$PM2_NAME')." \
                || warn "Could not restart PM2 '$PM2_NAME' — start it manually."
            if [[ $EUID -eq 0 ]]; then
                pm2_boot_autostart
            else
                info "Not root — skipping boot-autostart registration (run 'sudo $0 update' once to (re)register it)."
            fi
        else
            info "PM2 not installed — code updated; start the panel manually."
        fi
    fi
    summary
}

cmd_update() { # interactive 'update' — asks main vs dev when run from a terminal
    banner
    find_panel_dir
    require_git_panel
    INSTALL_MODE="reinstall"
    choose_update_branch
    update_flow
}

cmd_update_dev() { # one-shot 'update-dev' — always pulls the dev branch (latest features)
    banner
    find_panel_dir
    require_git_panel
    INSTALL_MODE="reinstall"
    BRANCH="dev"
    BRANCH_SET=true
    info "Updating from the 'dev' branch (latest features)."
    update_flow
}

cmd_service() { # start|stop|restart
    local action=$1
    if ! pm2_cmd list >/dev/null 2>&1; then exit 1; fi
    find_panel_dir
    case "$action" in
        start)   if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then pm2 start "$PM2_NAME" >/dev/null || true
                 else pm2 start "$PANEL_DIR/ecosystem.config.cjs" >/dev/null || true; fi ;;
        stop)    pm2 stop "$PM2_NAME" >/dev/null || true ;;
        restart) pm2 restart "$PM2_NAME" --update-env >/dev/null || true ;;
    esac
    ok "PM2 '$PM2_NAME' $action completed."
}

cmd_status() {
    banner
    find_panel_dir
    echo ""
    if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        pm2 describe "$PM2_NAME" 2>/dev/null | grep -E "status|name|script|exec cwd|restarts|uptime|unstable restarts|created at" | sed 's/^/  /' || true
    else
        warn "PM2 service '$PM2_NAME' not running."
    fi
    if [[ -d "$PANEL_DIR/.git" ]]; then
        cd "$PANEL_DIR"
        echo -e "  ${CYAN}code:${NC} $(git rev-parse --short HEAD) on $(git branch --show-current)"
        echo -e "  ${CYAN}dir :${NC} $PANEL_DIR"
    fi
    if [[ -f "$PANEL_DIR/version.json" ]]; then
        echo -e "  ${CYAN}panel version:${NC} v$(sed -n 's/.*"version"[^0-9]*\([0-9.]*\).*/\1/p' "$PANEL_DIR/version.json" | head -n1)"
    fi
    echo ""
}

cmd_logs() {
    if ! pm2_cmd logs "$PM2_NAME" --lines 50 --nostream; then
        info "Use: pm2 logs $PM2_NAME (live view)"
        exit 1
    fi
}

cmd_uninstall() {
    banner
    require_root "uninstall"
    find_panel_dir
    echo -e "\n${RED}This will remove the PM2 service AND delete $PANEL_DIR entirely.${NC}"
    confirm "Really uninstall PurpleMC Panel?" || { err "Cancelled."; exit 1; }
    command -v pm2 &>/dev/null && pm2 delete "$PM2_NAME" >/dev/null 2>&1 && pm2 save --silent || true
    if cwd_inside "$PANEL_DIR"; then cd /; fi  # never rm the cwd we're inside
    if [[ -d "$PANEL_DIR" ]]; then rm -rf "$PANEL_DIR" && ok "Removed $PANEL_DIR."; fi
    ok "Uninstall complete."
}

summary() {
    local ip
    ip=$(curl -4 -s -m 6 ifconfig.me || curl -4 -s -m 6 icanhazip.com || echo "localhost")
    echo ""
    hr
    echo -e "${GREEN}  ✅ Setup finished successfully${NC}"
    hr
    echo -e "  Panel UI : ${CYAN}http://$ip:$PORT${NC}"
    echo -e "  Directory: $PANEL_DIR"
    echo -e "  Commands : ./install.sh status | logs | update"
    ! $NO_PM2 && echo -e "  PM2      : pm2 status $PM2_NAME / pm2 logs $PM2_NAME"
    ! $NO_PM2 && ! $NO_AUTOSTART && echo -e "  Boot     : panel + Minecraft server auto-start on machine power-on (pm2 startup)"
    echo ""
}

# ════════════════════════════════════════════════════════════
# INTERACTIVE MENU
# ════════════════════════════════════════════════════════════

show_menu() {
    while true; do
        banner
        echo -e "  ${CYAN}Select an option:${NC}\n"
        echo -e "  ${GREEN}1)${NC} 🚀  New server/PC setup  (guided full install from zero)"
        echo -e "  ${GREEN}2)${NC} 📦  Install panel        (new or reinstall)"
        echo -e "  ${GREEN}3)${NC} 🔄  Update panel          (choose main or dev, keep data)"
        echo -e "  ${GREEN}4)${NC} ♻️   Fresh install         (wipe & scratch install)"
        echo -e "  ${GREEN}5)${NC} ▶️   Start service"
        echo -e "  ${GREEN}6)${NC} ⏹️   Stop service"
        echo -e "  ${GREEN}7)${NC} 🔁  Restart service"
        echo -e "  ${GREEN}8)${NC} 📊  Status"
        echo -e "  ${GREEN}9)${NC} 📜  Logs"
        echo -e "  ${GREEN}10)${NC} 🗑️   Uninstall"
        echo -e "  ${GREEN}0)${NC} Exit\n"
        local choice
        choice=$(prompt "Choose [0-10]:" "0")
        echo ""
        case "$choice" in
            1) INSTALL_MODE=""; cmd_setup ;;
            2) INSTALL_MODE=""; cmd_install ;;
            3) cmd_update ;;
            4) INSTALL_MODE="fresh"; cmd_install ;;
            5) cmd_service start ;;
            6) cmd_service stop ;;
            7) cmd_service restart ;;
            8) cmd_status ;;
            9) cmd_logs ;;
            10) cmd_uninstall ;;
            0) echo -e "${GREEN}Bye!${NC}"; exit 0 ;;
            *) warn "Invalid choice." ;;
        esac
        echo ""
        if [[ -t 0 ]] || [[ -e /dev/tty ]]; then
            confirm "Run another action?" || exit 0
        else
            exit 0
        fi
    done
}

# ════════════════════════════════════════════════════════════
# ARGUMENT PARSING & ENTRY
# ════════════════════════════════════════════════════════════

ARGS=""
ACTION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        setup|install|update|update-dev|fresh|start|stop|restart|status|logs|uninstall)
            ACTION="$1"; shift ;;
        --port)        PORT="${2:?Missing port value}"; ARGS="$ARGS $1 $2"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:?Missing install-dir value}"; INSTALL_DIR_SET=true; PANEL_DIR="$INSTALL_DIR"; ARGS="$ARGS $1 $2"; shift 2 ;;
        --repo)        REPO_URL="${2:?Missing repo URL}"; shift 2 ;;
        --branch)      BRANCH="${2:?Missing branch name}"; BRANCH_SET=true; shift 2 ;;
        --pm2-name)    PM2_NAME="${2:?Missing PM2 name}"; shift 2 ;;
        --no-pm2)      NO_PM2=true; shift ;;
        --no-java)     NO_JAVA=true; shift ;;
        --no-autostart) NO_AUTOSTART=true; shift ;;
        --unattended)  UNATTENDED=true; shift ;;
        --help|-h)     usage; exit 0 ;;
        *)             err "Unknown option or action: $1"; usage; exit 1 ;;
    esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    err "Invalid port: $PORT (expected 1-65535)"
    exit 1
fi

case "$ACTION" in
    "")
        if [[ -t 0 ]]; then
            show_menu                       # interactive shell → menu
        elif [[ -e /dev/tty ]]; then
            cmd_setup                       # piped one-liner on a fresh machine → full setup
        else
            usage; exit 1                   # fully headless → be explicit
        fi
        ;;
    setup)     INSTALL_MODE=""; cmd_setup ;;
    install)   INSTALL_MODE=""; cmd_install ;;
    fresh)     INSTALL_MODE="fresh"; cmd_install ;;
    update)    cmd_update ;;
    update-dev) cmd_update_dev ;;
    start|stop|restart) cmd_service "$ACTION" ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    uninstall) cmd_uninstall ;;
esac

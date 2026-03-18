#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Elite BGS Intelligence Platform — Linux Companion Installer
# ─────────────────────────────────────────────────────────────────────────────
# Checks for Node.js 18+, installs it if missing, then launches first-time setup.
# Run once after downloading the companion.

set -e
cd "$(dirname "$0")"

CYAN='\033[36m'; GREEN='\033[32m'; AMBER='\033[33m'; RED='\033[31m'; RESET='\033[0m'; BOLD='\033[1m'
info() { echo -e "${CYAN}◈${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${AMBER}⚠${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; }

echo ""
echo -e "${CYAN}◈ ═══════════════════════════════════════════════════════════════${RESET}"
echo -e "${CYAN}◈${RESET}  ${BOLD}ELITE BGS INTELLIGENCE PLATFORM${RESET}  —  Linux Companion Installer"
echo -e "${CYAN}◈ ═══════════════════════════════════════════════════════════════${RESET}"
echo ""

# ── Check / install Node.js ───────────────────────────────────────────────────

install_node_apt() {
  info "Installing Node.js 22 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

install_node_nvm() {
  info "Installing Node.js via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  nvm alias default 22
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -ge 18 ]; then
    ok "Node.js $(node --version) already installed."
  else
    warn "Node.js $NODE_VER found but 18+ is required."
    # Try to upgrade
    if command -v apt-get &>/dev/null && [ -n "$(which curl)" ]; then
      install_node_apt
    elif command -v nvm &>/dev/null; then
      install_node_nvm
    else
      fail "Please upgrade Node.js manually: https://nodejs.org/"
      fail "Or install nvm: https://github.com/nvm-sh/nvm"
      exit 1
    fi
  fi
else
  warn "Node.js not found. Installing..."
  if command -v apt-get &>/dev/null && command -v curl &>/dev/null; then
    install_node_apt
  elif command -v nvm &>/dev/null; then
    install_node_nvm
  elif command -v curl &>/dev/null; then
    # Fall back to nvm install
    install_node_nvm
  else
    fail "Cannot install Node.js automatically."
    fail "Install curl first:  sudo apt install curl"
    fail "Then re-run:         ./install.sh"
    exit 1
  fi
fi

# Confirm node is available (nvm may need sourcing)
if ! command -v node &>/dev/null; then
  # nvm installed but not in PATH yet — source it
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
fi

ok "Node.js $(node --version) ready."

# ── Make scripts executable ───────────────────────────────────────────────────
chmod +x companion.js start.sh install.sh
ok "Permissions set."

# ── Copy example config if no config exists ───────────────────────────────────
if [ ! -f companion.conf ] && [ -f companion.conf.example ]; then
  info "No companion.conf found — you'll set up on first run."
fi

echo ""
echo -e "${GREEN}Installation complete.${RESET}"
echo ""
echo -e "  Run the companion:     ${CYAN}./start.sh${RESET}"
echo -e "  With overlay:          ${CYAN}./start.sh --overlay${RESET}"
echo -e "  Re-run setup:          ${CYAN}./start.sh --setup${RESET}"
echo ""
echo -e "  On first launch, a setup wizard will ask for:"
echo -e "    • Your squadron slug  (e.g. ${CYAN}my-squadron${RESET})"
echo -e "    • Your CMDR name"
echo -e "    • Your portal password"
echo -e "    • Your journal folder  (auto-detected for most installs)"
echo ""

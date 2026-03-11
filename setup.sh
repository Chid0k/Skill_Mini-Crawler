#!/usr/bin/env bash
# setup.sh — Bootstrap the crawler on a new machine
# Usage: bash setup.sh
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── 1. Node.js ──────────────────────────────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
  error "Node.js not found. Install it from https://nodejs.org (>=18 required)."
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$MAJOR" -lt 18 ]; then
  error "Node.js $NODE_VER found but >=18 is required. Please upgrade."
fi
info "Node.js $NODE_VER — OK"

# ── 2. npm ──────────────────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  error "npm not found. It should come with Node.js."
fi
info "npm $(npm --version) — OK"

# ── 3. Install dependencies ─────────────────────────────────────────────────
info "Installing npm dependencies..."
npm install
info "Dependencies installed."

# ── 4. Output directory ─────────────────────────────────────────────────────
mkdir -p output
info "Output directory: ./output"

# ── 5. Puppeteer / Chromium note ────────────────────────────────────────────
if [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
  info "PUPPETEER_EXECUTABLE_PATH is set to: $PUPPETEER_EXECUTABLE_PATH"
elif [ -n "${PUPPETEER_SKIP_CHROMIUM_DOWNLOAD:-}" ]; then
  warn "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set but PUPPETEER_EXECUTABLE_PATH is not."
  warn "Make sure a Chromium/Chrome binary is available on PATH, or pass --browserless."
else
  info "Puppeteer will use its bundled Chromium (downloaded via npm install)."
fi

# ── 6. .env ─────────────────────────────────────────────────────────────────
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  info "Created .env from .env.example — edit it to customise your environment."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "Setup complete! Run the crawler with:"
echo ""
echo "    node index.js <url> [options]"
echo "    node index.js --help"
echo ""
echo "  Or with Docker:"
echo ""
echo "    docker build -t browserless-crawler ."
echo "    docker run --rm -v \"\$(pwd)/output:/app/output\" browserless-crawler <url>"
echo ""

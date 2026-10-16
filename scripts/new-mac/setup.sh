#!/bin/bash
# Run on the NEW Mac, from a fresh clone of the repo: sets up everything to code and run Roofline locally.
# Safe to run again: each step checks first and skips what is already done.
#   bash scripts/new-mac/setup.sh [path to the AirDropped roofline-transfer folder]
# Steps that need you (a password or an app install) stop with a plain instruction; do it, then run this again.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TRANSFER="${1:-$HOME/Downloads/roofline-transfer}"
WORK="$HOME/RooflineWork"
ok() { printf '  \033[32mok\033[0m  %s\n' "$*"; }
todo() { printf '  \033[33mYOU\033[0m %s\n' "$*"; NEEDS_YOU=1; }
NEEDS_YOU=0

echo "== 1. Apple command line tools"
if xcode-select -p >/dev/null 2>&1; then ok "installed"; else todo "run: xcode-select --install   (then run this script again)"; fi

echo "== 2. Homebrew"
if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"; ok "installed"
else
  todo 'install Homebrew (asks for your Mac password): /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
fi

echo "== 3. Node 22 (via nvm, the same as the Air)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ] && command -v brew >/dev/null 2>&1; then brew install nvm >/dev/null && mkdir -p "$NVM_DIR"; fi
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; elif [ -s "$(brew --prefix 2>/dev/null)/opt/nvm/nvm.sh" ]; then . "$(brew --prefix)/opt/nvm/nvm.sh"; fi
if command -v nvm >/dev/null 2>&1; then
  nvm install 22 >/dev/null && nvm alias default 22 >/dev/null && ok "node $(node --version)"
  grep -q 'NVM_DIR' "$HOME/.zshrc" 2>/dev/null || cat >> "$HOME/.zshrc" <<'EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
EOF
else
  todo "nvm missing: install Homebrew first (step 2), then run this again"
fi

echo "== 4. Docker (the demo database and the database tests run in it)"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then ok "running ($(docker --version | cut -d, -f1))"
elif [ -d /Applications/Docker.app ]; then todo "open Docker Desktop once and wait for it to say it is running, then run this again"
else todo "install Docker Desktop for Apple silicon: https://www.docker.com/products/docker-desktop/  (or: brew install --cask docker)"; fi

echo "== 5. GitHub sign-in (to push and pull)"
if command -v gh >/dev/null 2>&1 || { command -v brew >/dev/null 2>&1 && brew install gh >/dev/null; }; then
  if gh auth status >/dev/null 2>&1; then ok "signed in"; else todo "run: gh auth login   (GitHub.com, HTTPS, log in with a browser)"; fi
fi
git config --global pull.ff only
git config --global fetch.prune true
[ -n "$(git config --global user.name)" ] || git config --global user.name "Parsa Salahshori Ardestani"

echo "== 6. Keys"
if [ -f "$REPO/.env.keys" ]; then ok ".env.keys present"
elif [ -f "$TRANSFER/env.keys" ]; then install -m 600 "$TRANSFER/env.keys" "$REPO/.env.keys" && ok "copied from $TRANSFER"
else todo "AirDrop the roofline-transfer folder from the Air (scripts/new-mac/make-bundle.sh makes it), then run this again"; fi

echo "== 7. Data that git does not carry (benchmark houses, window model, test data)"
mkdir -p "$WORK"
if [ -d "$WORK/roof-bench" ] && [ -d "$WORK/models" ]; then ok "already in $WORK"
elif [ -f "$TRANSFER/roofline-data.tar.gz" ]; then tar -C "$WORK" -xzf "$TRANSFER/roofline-data.tar.gz" && ok "unpacked into $WORK"
else todo "no data bundle yet at $TRANSFER (the app runs without it; the benchmarks need it)"; fi

echo "== 8. Claude's notes about this project"
MEM="$HOME/.claude/projects/$(echo "$HOME" | tr '/' '-')/memory"
if [ -f "$TRANSFER/claude-memory.tar.gz" ]; then
  mkdir -p "$MEM" && tmp="$(mktemp -d)" && tar -C "$tmp" -xzf "$TRANSFER/claude-memory.tar.gz" && cp -n "$tmp"/* "$MEM"/ 2>/dev/null; rm -rf "$tmp"; ok "copied into $MEM (nothing overwritten)"
else ok "skipped (no claude-memory.tar.gz)"; fi

if [ "$NEEDS_YOU" = 1 ]; then echo; echo "Do the YOU steps above, then run this script again."; exit 1; fi

echo "== 9. Packages, browser for tests, Python tools"
cd "$REPO" && npm ci --no-audit --no-fund --loglevel=error && ok "npm packages"
npx playwright install chromium >/dev/null 2>&1 && ok "test browser"
if [ ! -x "$WORK/venv/bin/python" ]; then python3 -m venv "$WORK/venv" && "$WORK/venv/bin/pip" -q install 'laspy[lazrs]' numpy pillow && ok "python venv (lidar tools)"; else ok "python venv"; fi

echo "== 10. Check it builds"
npm run typecheck >/tmp/roofline-setup-typecheck.log 2>&1 && ok "typecheck" || echo "  typecheck FAILED: see /tmp/roofline-setup-typecheck.log"

echo
echo "Done. Start the app:   cd $REPO && npm run demo     then open http://localhost:4500"
echo "Before you change code, read docs/TWO-MACS.md (how the Pro and the Air stay in step)."

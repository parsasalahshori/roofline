#!/usr/bin/env bash
# Roofline demo on a Mac, from nothing: installs what is missing, then runs the demo and opens the
# browser. Safe to run again; it skips whatever is already installed.
#
#   bash scripts/demo-mac.sh            (from a clone of the repository)
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/parsasalahshori/roofline/demo-mode/scripts/demo-mac.sh)"
#                                       (from nothing: clones into ~/roofline-demo first)
#   ROOFLINE_DEMO_BRANCH=demo-oct13 bash -c "$(curl -fsSL https://raw.githubusercontent.com/parsasalahshori/roofline/demo-oct13/scripts/demo-mac.sh)"
#                                       (a frozen demo branch; switching branches reseeds fresh demo data)
#
# What it may install: Homebrew (the official installer), Docker Desktop (brew cask), git, and
# fnm (a Node version manager) with the Node version pinned in .nvmrc. It never uses sudo itself;
# Homebrew's installer asks for your Mac password once, the first time only. It does not edit your
# shell profile: Homebrew and fnm are set up for this script's own run only.
set -euo pipefail

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n\n' "$*" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This script is for macOS. On Linux, install Node 22 and Docker, then run: npm install && npm run demo"
fi

REPO_URL="https://github.com/parsasalahshori/roofline.git"
BRANCH="${ROOFLINE_DEMO_BRANCH:-demo-mode}"
CLONE_DIR="${ROOFLINE_DEMO_DIR:-$HOME/roofline-demo}"
REPO_ROOT=""
DEMO_SCRIPT="demo"
if [[ -n "${BASH_SOURCE[0]:-}" && -f "$(dirname "${BASH_SOURCE[0]}")/../docker-compose.demo.yml" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

say "Roofline demo setup. The first run takes 5 to 15 minutes; later runs take about 1 minute."
echo "If Homebrew is not installed yet, macOS will ask for your Mac password once (that is Homebrew's installer)."

# 1. Homebrew
brew_env() {
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
}
brew_env
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (official installer)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew_env
  command -v brew >/dev/null 2>&1 || die "Homebrew did not install. See https://brew.sh and run this script again."
fi

# 2. git (Apple's command line tools usually have it already)
if ! command -v git >/dev/null 2>&1; then
  say "Installing git"
  brew install git
fi

# 3. The code (only when the script was not run from a clone)
if [[ -z "$REPO_ROOT" ]]; then
  if [[ -d "$CLONE_DIR/.git" ]]; then
    say "Updating the code in $CLONE_DIR"
    # Switching to another demo branch (ROOFLINE_DEMO_BRANCH) starts from fresh demo data, seeded by that branch.
    if [[ "$(git -C "$CLONE_DIR" rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]]; then DEMO_SCRIPT="demo:reset"; fi
    git -C "$CLONE_DIR" fetch origin "$BRANCH"
    git -C "$CLONE_DIR" checkout "$BRANCH"
    git -C "$CLONE_DIR" merge --ff-only "origin/$BRANCH" || echo "(Local changes in $CLONE_DIR: keeping them.)"
  else
    say "Downloading the code into $CLONE_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
  fi
  REPO_ROOT="$CLONE_DIR"
fi
cd "$REPO_ROOT"

# 4. Docker Desktop
if [[ ! -d /Applications/Docker.app ]] && ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker Desktop"
  brew install --cask docker-desktop || brew install --cask docker
fi
if ! docker info >/dev/null 2>&1; then
  say "Starting Docker Desktop"
  echo "The first time, Docker asks you to accept its terms: click Accept (you can skip signing in)."
  open -a Docker
  # Docker Desktop puts the docker command in place on its first launch.
  export PATH="$PATH:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
  for _ in $(seq 1 180); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 2
  done
  docker info >/dev/null 2>&1 || die "Docker Desktop did not start within 6 minutes. Open it from Applications, wait for 'Engine running', then run this script again."
fi
echo "Docker is running."

# 5. Node, the version in .nvmrc, through fnm
if ! command -v fnm >/dev/null 2>&1; then
  say "Installing fnm (Node version manager)"
  brew install fnm
fi
eval "$(fnm env --shell bash)"
say "Installing Node $(cat .nvmrc) (from .nvmrc)"
fnm install
fnm use
echo "Using Node $(node --version)."

# 6. Dependencies, then the demo
say "Installing the app's packages (npm ci, from the lockfile)"
npm ci --no-audit --no-fund

say "Starting the demo. Your browser opens when it is ready; press Ctrl+C here to stop it."
DEMO_OPEN=1 npm run "$DEMO_SCRIPT"

#!/usr/bin/env bash
# Elite BGS Intelligence Platform — Linux Companion launcher
# Usage: ./start.sh [--overlay] [--from-start] [--setup]

cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install it with: sudo apt install nodejs"
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "Error: Node.js 18+ required (you have $NODE_VER). Upgrade with: nvm install 22"
  exit 1
fi

exec node companion.js "$@"

#!/bin/zsh
# Double-click me → graphhog dashboard opens in your browser (macOS)
cd "$(dirname "$0")"

# node is often missing from the GUI PATH; probe common locations
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for c in ~/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found — please install Node.js (>= 16) first"; read -r "?Press Enter to exit"; exit 1
fi

exec "$NODE_BIN" graphhog.mjs "$@"

#!/bin/sh
# Launch the graphhog dashboard (Linux)
cd "$(dirname "$0")"

NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for c in ~/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found — please install Node.js (>= 16) first"
  exit 1
fi

exec "$NODE_BIN" graphhog.mjs "$@"

#!/bin/zsh
# Starts the VP Prep server; with --tunnel also opens a Cloudflare quick tunnel and prints the public link.
cd "$(dirname "$0")"
set -a; [ -f .env ] && source .env; set +a
mkdir -p state
node server.mjs >> state/server.log 2>&1 &
echo $! > state/server.pid
sleep 2
echo "Server: http://127.0.0.1:${PORT:-8787}"
if [[ "$1" == "--tunnel" ]]; then
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT:-8787}" > state/tunnel.log 2>&1 &
  echo $! > state/tunnel.pid
  for i in {1..30}; do U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' state/tunnel.log | head -1); [ -n "$U" ] && break; sleep 1; done
  echo "Phone link: ${U:-'(not ready, see state/tunnel.log)'}"
fi

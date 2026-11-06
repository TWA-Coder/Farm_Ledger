#!/usr/bin/env bash
# FarmLedger local demo for macOS and Linux: chain, contracts + seed data, bundler, phone services, web portal.
#   ./start-demo.sh        then open http://localhost:3000      Ctrl+C stops everything.
# Logs: services/out/*.log
set -euo pipefail
cd "$(dirname "$0")"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "FarmLedger needs Node.js 22.5 or later (you have $(node -v 2>/dev/null || echo none)). Install it from https://nodejs.org"; exit 1; }
for port in 8545 3000 4000 4100 4337; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $port is already in use (another FarmLedger demo running?). Stop it first."; exit 1; fi
done

[ -d node_modules ] || npm install
[ -d web/node_modules ] || npm run web:install
mkdir -p services/out

pids=()
cleanup() { echo; echo "Stopping FarmLedger..."; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting the local chain..."
npm run node > services/out/chain.log 2>&1 & pids+=($!)
for i in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' http://127.0.0.1:8545 >/dev/null 2>&1 && break
  sleep 1
done
npm run deploy:local
npm run seed

echo "Starting the bundler, phone services and web portal..."
npm run bundler > services/out/bundler.log 2>&1 & pids+=($!)
npm run phone > services/out/phone.log 2>&1 & pids+=($!)
npm run web > services/out/web.log 2>&1 & pids+=($!)
for i in $(seq 1 90); do curl -s -o /dev/null http://localhost:3000 && break; sleep 1; done

cat <<MSG

  FarmLedger is running.
    Landing page       http://localhost:3000
    Portal             http://localhost:3000/app      (pick a demo account at the top)
    Phone simulator    http://localhost:3000/ussd
  Logs in services/out/. Press Ctrl+C to stop everything.

MSG
if command -v open >/dev/null; then open http://localhost:3000/app; elif command -v xdg-open >/dev/null; then xdg-open http://localhost:3000/app >/dev/null 2>&1 || true; fi
wait

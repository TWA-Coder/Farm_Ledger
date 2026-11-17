#!/usr/bin/env bash
# Installs FarmLedger's services on an Ubuntu VM (tested: Oracle Cloud Always Free, Ubuntu 24.04), from the repo root:
#   sudo deploy/vm/install.sh <public-ip> [network]        e.g.  sudo deploy/vm/install.sh 155.248.230.250
# Before: Node 22.5+, Caddy and cloudflared installed; npm ci (root and web/); .env and .env.<network> copied; contracts
# deployed (deployments/<network>.json). See docs/POLYGON_AMOY.md, "Hosting on a VM".
# What it does (safe to run again): writes /etc/caddy/Caddyfile and the four farmledger-* systemd units from the
# templates in this folder, opens ports 80/443 in the VM's firewall (iptables, persisted), builds the portal and
# (re)starts everything. Oracle's own network rules (security list ingress 80/443) are set in the OCI console.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
IP="${1:?usage: sudo deploy/vm/install.sh <public-ip> [network]}"
NETWORK="${2:-polygonAmoy}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$HERE/../.." && pwd)"
USER_NAME="${SUDO_USER:-$(stat -c %U "$DIR")}"
NODE="$(sudo -u "$USER_NAME" bash -lc 'command -v node')"
HOST="${IP//./-}.sslip.io"

[ -f "$DIR/deployments/$NETWORK.json" ] || { echo "deployments/$NETWORK.json not found: deploy the contracts first."; exit 1; }
for f in .env ".env.$NETWORK"; do [ -f "$DIR/$f" ] || { echo "$f not found in $DIR."; exit 1; }; chmod 600 "$DIR/$f"; done
command -v caddy >/dev/null || { echo "Caddy is not installed (see docs/POLYGON_AMOY.md)."; exit 1; }
command -v cloudflared >/dev/null || echo "Warning: cloudflared is not installed; farmledger-tunnel will fail."

fill() { sed -e "s|@USER@|$USER_NAME|g" -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" -e "s|@NETWORK@|$NETWORK|g" -e "s|@HOST@|$HOST|g" "$1"; }

echo "Caddy for https://$HOST"
fill "$HERE/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && touch /var/log/caddy/farmledger-access.log && chown -R caddy:caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile >/dev/null
chown caddy:caddy /var/log/caddy/farmledger-access.log # validate may recreate it as root, and Caddy then cannot write it

for s in bundler phone web tunnel; do fill "$HERE/farmledger-$s.service" > "/etc/systemd/system/farmledger-$s.service"; done

echo "Firewall: ports 80 and 443"
for p in 443 80; do
  iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 5 -p tcp --dport $p -m state --state NEW -j ACCEPT # before Oracle's final REJECT rule
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || echo "Install iptables-persistent to keep the rules after a reboot."

echo "Building the portal (a few minutes on a small VM)"
systemctl stop farmledger-web 2>/dev/null || true
sudo -u "$USER_NAME" bash -lc "cd '$DIR/web' && NETWORK=$NETWORK NODE_OPTIONS=--max-old-space-size=1536 npx next build >/dev/null"

systemctl daemon-reload
systemctl enable farmledger-bundler farmledger-phone farmledger-web farmledger-tunnel >/dev/null 2>&1
systemctl restart farmledger-bundler farmledger-phone farmledger-web farmledger-tunnel
systemctl reload caddy
sleep 20
systemctl is-active farmledger-bundler farmledger-phone farmledger-web farmledger-tunnel caddy | paste -sd' ' | sed 's/^/Services: /'
echo "Portal:          https://$HOST"
echo "USSD callback:   $(journalctl -u farmledger-tunnel --no-pager -o cat | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)/ussd?key=<CALLBACK_TOKEN>"
echo "                 (the tunnel address changes whenever farmledger-tunnel restarts: paste the new one into Africa's Talking)"

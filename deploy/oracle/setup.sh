#!/usr/bin/env bash
# Runs on the Oracle VM (deploy.sh calls it). Sized for the free 1 GB micro VM: 4 GB swap, PostgreSQL and Redis
# on this VM with small memory settings, the platform as a systemd service, Caddy for HTTPS. Safe to run again.
set -euo pipefail

DOMAIN="${1:?Usage: setup.sh <domain>}"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE=/opt/ctp/.env
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o Dpkg::Options::=--force-confold -qq"

echo "→ Swap (4 GB, so the build fits in 1 GB RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "→ Packages (Node 22, PostgreSQL 17, Redis, Caddy)"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
fi
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list
fi
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
fi
$APT update
$APT install -y nodejs postgresql-17 redis-server caddy openssl iptables-persistent >/dev/null

echo "→ PostgreSQL and Redis (small memory settings)"
cat > /etc/postgresql/17/main/conf.d/ctp.conf <<PG
shared_buffers = 64MB
work_mem = 4MB
maintenance_work_mem = 32MB
max_connections = 40
PG
systemctl restart postgresql
sed -i 's/^#\? *maxmemory .*/maxmemory 64mb/; s/^appendonly no/appendonly yes/' /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || echo 'maxmemory 64mb' >> /etc/redis/redis.conf
grep -q '^maxmemory-policy noeviction' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
systemctl enable --now redis-server >/dev/null && systemctl restart redis-server

echo "→ Secrets ($ENV_FILE)"
mkdir -p /opt/ctp
if [ ! -f "$ENV_FILE" ]; then
  PG_PASS="$(openssl rand -hex 24)"
  umask 077
  cat > "$ENV_FILE" <<ENV
PUBLIC_DOMAIN=$DOMAIN
PORT=3000
DATABASE_URL=postgresql://ctp:$PG_PASS@127.0.0.1:5432/copy_trading?schema=public
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -base64 32)
PAPER_MODE=true
# Fill these in (sudo nano $ENV_FILE), then: sudo systemctl restart ctp
ZERODHA_API_KEY=
ZERODHA_API_SECRET=
ANGEL_API_KEY=
ANGEL_PUBLIC_IP=
ENV
  sudo -u postgres psql -q -c "CREATE ROLE ctp LOGIN PASSWORD '$PG_PASS';"
  sudo -u postgres psql -q -c "CREATE DATABASE copy_trading OWNER ctp;"
  echo "  Created with new secrets and an empty database."
fi
chmod 600 "$ENV_FILE"

echo "→ Building the platform (slow on 1 GB, about 10-20 minutes the first time)"
chown -R ubuntu:ubuntu "$APP_DIR"
sudo -u ubuntu bash -c "cd '$APP_DIR' && export NODE_OPTIONS=--max-old-space-size=2048 && npm ci --no-audit --no-fund && npm run build -w @ctp/api && npm run build -w @ctp/web"

echo "→ Service"
cat > /etc/systemd/system/ctp.service <<UNIT
[Unit]
Description=Copy trading platform (API + web)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=API_INTERNAL_URL=http://127.0.0.1:4000
ExecStart=/bin/sh scripts/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ctp >/dev/null
systemctl restart ctp

echo "→ Caddy (HTTPS for $DOMAIN)"
cat > /etc/caddy/Caddyfile <<CADDY
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
CADDY
systemctl enable caddy >/dev/null
systemctl restart caddy

echo "→ Firewall (ports 80 and 443)"
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    reject="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    if [ -n "$reject" ]; then
      iptables -I INPUT "$reject" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
netfilter-persistent save >/dev/null 2>&1 || true

cat <<DONE

Done. Point $DOMAIN and www.$DOMAIN (A records) at this VM's public IP; HTTPS starts once DNS points here.
Logs:  sudo journalctl -u ctp -f
DONE

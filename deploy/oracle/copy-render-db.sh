#!/usr/bin/env bash
# Run on the Oracle VM, once, after setup.sh: copies all data from the Render database into the VM's database.
#   sudo bash ~/ctp/deploy/oracle/copy-render-db.sh
# It asks for Render's External Database URL and ENCRYPTION_KEY (typed, not shown, not saved in history).
# Saved broker credentials are encrypted with Render's key, so the VM must use the same key to read them.
set -euo pipefail

ENV_FILE=/opt/ctp/.env
# Render runs PostgreSQL 18; an older pg_dump refuses to dump it.
PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump
[ -x "$PG_DUMP" ] || apt-get install -y -qq postgresql-client-18 >/dev/null

read -rsp "Render External Database URL: " RENDER_URL; echo
read -rsp "Render ENCRYPTION_KEY (Enter to keep the VM's key): " RENDER_KEY; echo
RENDER_URL="$(printf '%s' "$RENDER_URL" | tr -d '[:space:]')"
RENDER_KEY="$(printf '%s' "$RENDER_KEY" | tr -d '[:space:]')"
# Render only accepts SSL connections from outside.
case "$RENDER_URL" in *sslmode=*) ;; *\?*) RENDER_URL="$RENDER_URL&sslmode=require" ;; *) RENDER_URL="$RENDER_URL?sslmode=require" ;; esac

echo "→ Checking the Render connection"
"$PG_DUMP" --schema-only "$RENDER_URL" >/dev/null || { echo "Could not connect to Render. Nothing was changed."; exit 1; }

echo "→ Stopping the app"
systemctl stop ctp
# Whatever happens next, start the app again (it recreates missing tables on start).
trap 'systemctl start ctp' EXIT

echo "→ Emptying the VM database"
sudo -u postgres psql -q -d copy_trading -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION ctp;'

echo "→ Copying from Render"
"$PG_DUMP" --no-owner --no-acl "$RENDER_URL" | sudo -u postgres psql -q -d copy_trading >/dev/null
sudo -u postgres psql -q -d copy_trading -c 'GRANT ALL ON ALL TABLES IN SCHEMA public TO ctp; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ctp;
  DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '"'"'public'"'"' LOOP
    EXECUTE format('"'"'ALTER TABLE public.%I OWNER TO ctp'"'"', r.tablename); END LOOP; END $$;'

if [ -n "$RENDER_KEY" ]; then
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$RENDER_KEY|" "$ENV_FILE"
  echo "→ ENCRYPTION_KEY set to Render's"
fi

echo "→ Starting the app"
sudo -u postgres psql -d copy_trading -c '\dt'
echo "Done."

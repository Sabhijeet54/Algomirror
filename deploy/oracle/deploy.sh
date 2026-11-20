#!/usr/bin/env bash
# Run on your Mac. Copies the platform to the Oracle VM (the one Chesi runs on) and starts or updates it.
#
#   deploy/oracle/deploy.sh ubuntu@<vm-ip> ~/Downloads/ssh-key.key cryptocraft.co.in
set -euo pipefail

TARGET="${1:?Usage: $0 ubuntu@<vm-ip> <ssh-key-file> <domain>}"
KEY="${2:?Give the SSH private key file of the VM}"
DOMAIN="${3:?Give the domain, e.g. cryptocraft.co.in}"
EXTRA_DOMAINS="${4:-}"
SITE_ORIGINS="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

chmod 600 "$KEY"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "→ Copying the platform to $TARGET"
rsync -az --delete -e "${SSH[*]}" \
  --exclude node_modules --exclude .git --exclude .env --exclude '.env.*' --exclude '.next' --exclude dist \
  --exclude 'Claude outputs' --exclude '*.tsbuildinfo' \
  "$ROOT/" "$TARGET:ctp/"

if [ -n "${SMTP_PASSWORD:-}" ]; then
  echo "→ Mail settings (sent over SSH stdin, merged into the VM's .env by setup.sh)"
  printf 'SMTP_HOST=%s\nSMTP_PORT=%s\nSMTP_USER=%s\nSMTP_PASSWORD=%s\nMAIL_FROM="%s"\nENQUIRY_NOTIFY_EMAIL=%s\n' \
    "${SMTP_HOST:?}" "${SMTP_PORT:-465}" "${SMTP_USER:?}" "$SMTP_PASSWORD" "${MAIL_FROM:?}" "${ENQUIRY_NOTIFY_EMAIL:-}" |
    "${SSH[@]}" "$TARGET" 'umask 077; cat > ctp-mail.env'
fi

echo "→ Setting up / updating on the VM (the first build takes several minutes)"
"${SSH[@]}" "$TARGET" "sudo bash ctp/deploy/oracle/setup.sh $DOMAIN '$EXTRA_DOMAINS' '$SITE_ORIGINS'"

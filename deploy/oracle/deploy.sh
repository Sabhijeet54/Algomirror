#!/usr/bin/env bash
# Run on your Mac. Copies the platform to the Oracle VM (the one Chesi runs on) and starts or updates it.
#
#   deploy/oracle/deploy.sh ubuntu@<vm-ip> ~/Downloads/ssh-key.key cryptocraft.co.in
set -euo pipefail

TARGET="${1:?Usage: $0 ubuntu@<vm-ip> <ssh-key-file> <domain>}"
KEY="${2:?Give the SSH private key file of the VM}"
DOMAIN="${3:?Give the domain, e.g. cryptocraft.co.in}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

chmod 600 "$KEY"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "→ Copying the platform to $TARGET"
rsync -az --delete -e "${SSH[*]}" \
  --exclude node_modules --exclude .git --exclude .env --exclude '.env.*' --exclude '.next' --exclude dist \
  --exclude 'Claude outputs' --exclude '*.tsbuildinfo' \
  "$ROOT/" "$TARGET:ctp/"

echo "→ Setting up / updating on the VM (the first build takes several minutes)"
"${SSH[@]}" "$TARGET" "sudo bash ctp/deploy/oracle/setup.sh $DOMAIN"

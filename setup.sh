#!/usr/bin/env bash
# One-shot Cloudflare setup for Dids File Storage.
# Requires: wrangler (npm i -g wrangler) and `wrangler login`.
set -euo pipefail
cd "$(dirname "$0")"

BUCKET="dids-file-storage"
DBNAME="dids-file-storage"

echo "==> Creating R2 bucket ($BUCKET)…"
wrangler r2 bucket create "$BUCKET" || echo "   (bucket may already exist — continuing)"

echo "==> Creating D1 database ($DBNAME)…"
CREATE_OUT="$(wrangler d1 create "$DBNAME" 2>&1 || true)"
echo "$CREATE_OUT"
DBID="$(printf '%s\n' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"

if [ -n "${DBID:-}" ]; then
  echo "==> Writing database_id ($DBID) into wrangler.toml"
  sed -i.bak "s/PASTE_YOUR_D1_DATABASE_ID_HERE/$DBID/" wrangler.toml && rm -f wrangler.toml.bak
else
  echo "   Could not auto-detect the D1 id. If the DB already exists, run:"
  echo "     wrangler d1 list"
  echo "   then paste its id into wrangler.toml (database_id) before continuing."
fi

echo "==> Loading schema into D1 (remote)…"
wrangler d1 execute "$DBNAME" --remote --file=./schema.sql

echo "==> Setting secrets. You'll be prompted for each value."
echo "    ADMIN_KEY: the master admin key you'll type on the home page."
wrangler secret put ADMIN_KEY
echo "    SESSION_SECRET: any long random string (tip: openssl rand -hex 32)."
wrangler secret put SESSION_SECRET

echo "==> Deploying…"
wrangler deploy

echo
echo "Done. Open the printed URL, enter your ADMIN_KEY, then generate staff/public keys"
echo "under Auth Keys → + Generate key."

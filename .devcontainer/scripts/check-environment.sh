#!/usr/bin/env bash
set -euo pipefail

for tool in node npm git gh opencode docker sqlite3 python3 make g++ pkg-config curl jq rg shellcheck; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing required tool: $tool" >&2
    exit 1
  fi
done

node --version
npm --version
for tool in tsc tsx vite eslint prettier vitest playwright; do
  "$tool" --version
done
gh --version
opencode --version
docker --version
docker compose version
docker buildx version

pkg-config --exists sqlite3
sqlite_result="$(sqlite3 :memory: "CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('screensvr'); SELECT value FROM smoke;")"
if [[ "$sqlite_result" != "screensvr" ]]; then
  echo "SQLite smoke test failed." >&2
  exit 1
fi
echo "SQLite: in-memory read/write OK"

node /opt/screensvr-tooling/check-browsers.mjs

echo "Development environment checks passed."

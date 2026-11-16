#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [[ -f package.json ]]; then
  if [[ ! -f package-lock.json ]]; then
    echo "A package.json exists without package-lock.json. Commit an npm lockfile before using automatic setup." >&2
    exit 1
  fi

  npm ci --no-audit --no-fund

  # Project-local Playwright may require different browser revisions.
  if [[ -x node_modules/.bin/playwright ]]; then
    node_modules/.bin/playwright install chromium firefox webkit
  fi
else
  echo "No application package.json yet; the development toolchain is ready for scaffolding."
fi

bash .devcontainer/scripts/check-environment.sh

#!/usr/bin/env bash
# Deploys the committed HEAD to Vercel production from a clean archive: no working-tree edits, no .env files.
# Needs a checkout linked with `vercel link` (.vercel/project.json) and the Vercel CLI signed in.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit first: the working tree has changes." >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive HEAD | tar -x -C "$tmp"
mkdir -p "$tmp/.vercel"
cp .vercel/project.json "$tmp/.vercel/"
echo "Deploying $(git rev-parse --short HEAD) to production"
(cd "$tmp" && vercel deploy --prod --yes)

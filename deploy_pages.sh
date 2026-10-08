#!/usr/bin/env bash
# Publish /workspace/cqb-sight to GitHub Pages as <user>/cqb-sight. Requires: gh auth login (repo scope).
set -euo pipefail
cd "$(dirname "$0")"
gh auth status >/dev/null
USER=$(gh api user -q .login)
git init -q 2>/dev/null || true
git add -A && (git commit -qm "CQB Sight deploy $(date -Iseconds)" || true)
git branch -M main
if ! gh repo view "$USER/cqb-sight" >/dev/null 2>&1; then
  gh repo create cqb-sight --public --source . --remote origin --push
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$USER/cqb-sight.git"
  git push -u origin main
fi
gh api -X POST "repos/$USER/cqb-sight/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true
URL="https://$USER.github.io/cqb-sight/"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" || true); echo "[$i] $URL -> $code"
  [ "$code" = "200" ] && exit 0; sleep 15
done
echo "Pages not live yet; check https://github.com/$USER/cqb-sight/settings/pages"; exit 1

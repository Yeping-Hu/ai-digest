#!/usr/bin/env bash
set -euo pipefail

remote="${1:-origin}"
branch="${2:-main}"
max_attempts="${PUSH_RETRY_ATTEMPTS:-8}"
base_delay="${PUSH_RETRY_DELAY_SECONDS:-3}"

if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::PUSH_RETRY_ATTEMPTS must be a positive integer; got '$max_attempts'."
  exit 2
fi

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Synchronizing with ${remote}/${branch} before push (attempt ${attempt}/${max_attempts})..."
  git fetch --no-tags "$remote" "$branch"

  if ! git rebase "$remote/$branch"; then
    echo "::error::The remote branch changed and the local commit conflicts with it."
    echo "Resolve the conflicting data/code change rather than overwriting the newer remote commit."
    git status --short || true
    git rebase --abort || true
    exit 1
  fi

  if git push "$remote" "HEAD:$branch"; then
    echo "Push succeeded on attempt ${attempt}."
    exit 0
  fi

  if (( attempt < max_attempts )); then
    delay=$((base_delay * attempt))
    echo "::warning::${remote}/${branch} moved again while pushing. Retrying in ${delay}s."
    sleep "$delay"
  fi
done

echo "::error::Unable to push after ${max_attempts} attempts because ${remote}/${branch} kept changing."
exit 1

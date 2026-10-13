#!/usr/bin/env bash
# Refuse newly added misnamed manifests only when the branch's own manifest
# is absent at HEAD. Maintenance of existing manifests is always allowed.
# Deletions are out of scope; renames are checked as deletion + addition.
set -euo pipefail
expected="$1"
base="$2"

# Main pushes and manual dispatches have no PR base; retain their selection.
if [[ -z "$base" ]]; then exit 0; fi

# NUL delimiters keep spaces/newlines literal; pipefail refuses unreadable diffs.
# Inspect additions even when the expected manifest exists, so bad bases fail.
git diff --no-renames --name-only -z --diff-filter=A "${base}...HEAD" -- 'mutation-checks/*.json' |
  while IFS= read -r -d '' changed; do
    if [[ "$changed" != "$expected" ]] && ! git cat-file -e "HEAD:$expected" 2>/dev/null; then
      printf "%s\n" "Mutation manifest mismatch: expected '${expected}', found '${changed}'. Add or rename a manifest to the branch-derived name; that manifest is absent at HEAD." >&2
      exit 1
    fi
  done

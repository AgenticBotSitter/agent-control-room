#!/usr/bin/env bash
# Emit the NUL-delimited verification list. Refuse misnamed additions only
# when the branch's own manifest is absent. Deletions are out of scope;
# renames are checked as deletion + addition.
set -euo pipefail
expected="$1"
# With no PR base, HEAD...HEAD is empty: retain branch-only selection.
base="${2:-HEAD}"
pr_head="${3:-}"
# Checkout tests the PR merge against the current base tip, which may be
# newer than the event base. Only trust that topology for the event PR head.
if [[ -n "$pr_head" ]] && [[ "$(git rev-parse --verify HEAD^2 2>/dev/null || true)" == "$pr_head" ]]; then
  base=$(git rev-parse --verify HEAD^1)
fi

regular_manifest() {
  local kind entry
  kind=$(git cat-file -t "HEAD:$1")
  entry=$(git ls-tree HEAD -- "$1")
  if [[ "$kind" != blob ]] || [[ "$entry" != 100644\ blob\ * && "$entry" != 100755\ blob\ * ]]; then
    printf "Mutation manifest '%s' is not a regular manifest blob.\n" "$1" >&2
    return 1
  fi
}

own=false
if git cat-file -e "HEAD:$expected" 2>/dev/null; then
  regular_manifest "$expected"
  own=true
fi

# NUL delimiters preserve filenames; pipefail refuses unreadable PR bases.
git diff --no-renames --name-only -z --diff-filter=A "${base}...HEAD" -- ':(top,glob)mutation-checks/*.json' |
  while IFS= read -r -d '' changed; do
    if [[ "$changed" != "$expected" && "$own" != true ]]; then
      printf "%s\n" "Mutation manifest mismatch: expected '${expected}', found '${changed}'. Add or rename a manifest to the branch-derived name; no mutations were selected." >&2
      exit 1
    fi
  done

if [[ "$own" == true ]]; then printf '%s\0' "$expected"; fi
git diff --no-renames --name-only -z --diff-filter=AM "${base}...HEAD" -- ':(top,glob)mutation-checks/*.json' |
  while IFS= read -r -d '' changed; do
    regular_manifest "$changed"
    if [[ "$changed" != "$expected" ]]; then printf '%s\0' "$changed"; fi
  done

#!/usr/bin/env bash
# PRs may edit another branch's manifest only after an explicit shared entry
# is reviewed here. Keep entries as exact repository-relative filenames.
set -euo pipefail
expected="$1"
base="$2"
shared_manifests=()

# Main pushes and manual dispatches have no PR base; retain their selection.
if [[ -z "$base" ]]; then exit 0; fi

# Treat renames as deletion + addition: only the destination needs validation.
# NUL delimiters keep spaces/newlines literal; pipefail refuses unreadable diffs.
git diff --no-renames --name-only -z --diff-filter=ACMT "${base}...HEAD" -- 'mutation-checks/*.json' |
  while IFS= read -r -d '' changed; do
    shared=false
    for allowed in ${shared_manifests[@]+"${shared_manifests[@]}"}; do
      if [[ "$changed" == "$allowed" ]]; then shared=true; fi
    done
    if [[ "$changed" != "$expected" && "$shared" != true ]]; then
      printf "%s\n" "Mutation manifest mismatch: expected '${expected}', found '${changed}'. Rename the changed manifest to the branch-derived name or explicitly list it in shared_manifests in scripts/ci/check-mutation-manifest-branch.sh." >&2
      exit 1
    fi
  done

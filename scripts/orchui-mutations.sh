#!/usr/bin/env bash
# Mutation proof for the eight guards the first-layer review found untested
# (F2: M6, M8, M9, M10, M12, M13, M16, M17), plus the guards this stream added
# for F1/F3/F4/F5/F6/F8. Each mutation is applied to the working tree, the focused
# lane is re-run, and a failure is the PASS condition. Every mutation is restored
# with git checkout afterwards; the tree must end clean.
#
# Usage: bash scripts/orchui-mutations.sh
set -u
cd "$(dirname "$0")/.."

LANE=(tests/project-orchestration-owner.test.ts tests/project-orchestration-ui.test.tsx)
OWNER=src/web/v1/project-orchestration-owner.ts
HTTP=src/web/v1/project-orchestration-http.ts
BROWSER=src/web/v1/project-orchestration-browser-client.ts
UI=private-app/app/project-orchestration.tsx
PIPES=private-app/app/project-pipelines-workspace.tsx
RESULTS_DIR="${RESULTS_DIR:-${TMPDIR:-/tmp}/orchui-mutations}"
mkdir -p "$RESULTS_DIR"

pass=0; fail=0; failures=""
# mutate <id> <file> <old> <new>  -- a `python3` free literal replace, one guard.
mutate() {
  local id="$1" file="$2" old="$3" new="$4"
  if ! grep -qF -- "$old" "$file"; then
    echo "SETUP-ERROR $id: anchor not found in $file" | tee "$RESULTS_DIR/$id.log"
    fail=$((fail+1)); failures="$failures $id(setup)"; return
  fi
  python3 - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf8").read()
assert text.count(old) == 1, f"anchor is not unique ({text.count(old)})"
open(path, "w", encoding="utf8").write(text.replace(old, new))
PY
  if node --import tsx --test "${LANE[@]}" > "$RESULTS_DIR/$id.log" 2>&1; then
    echo "ESCAPED  $id  (the lane still passed with the guard removed)" | tee -a "$RESULTS_DIR/summary.txt"
    fail=$((fail+1)); failures="$failures $id(ESCAPED)"
  else
    local which
    which=$(grep -oE "^✖ .*" "$RESULTS_DIR/$id.log" | head -3 | sed 's/^✖ //' | paste -sd ';' -)
    echo "CAUGHT   $id  <- $which" | tee -a "$RESULTS_DIR/summary.txt"
    pass=$((pass+1))
  fi
  git checkout -- "$file"
}

: > "$RESULTS_DIR/summary.txt"

# M6: dismiss's current-state/revision check in the adapter.
mutate M6-dismiss-revision-check "$OWNER" \
  'if (current.state !== "proposed" || current.revision !== expectedRevision) throw new WebAccessError("conflict");
      const dismissed = await options.store.dismissedSuggestionIds' \
  'const dismissed = await options.store.dismissedSuggestionIds'

# M6b: the same check at the store (the in-memory double's own binding).
mutate M6b-dismiss-store-binding "$OWNER" \
  'const value = this.#find(input);
    if (value.baseRevision !== input.expectedRevision) throw new WebAccessError("conflict");
    this.#dismissed.add(value.suggestionId);' \
  'const value = this.#find(input);
    this.#dismissed.add(value.suggestionId);'

# M8: the SERVICE boundary stops cloning and freezing whatever the coordinator's
# store returned. This is the seam a future durable adapter would land wrong, and
# it is deliberately not the in-memory double's own internal copy.
mutate M8-prefill-deep-clone "$OWNER" \
  'return deepFreeze(projectOrchestrationSuggestionPrefillSchemaV1.parse(await options.coordinator.ownerPrefill({' \
  'return projectOrchestrationSuggestionPrefillSchemaV1.parse(await options.coordinator.ownerPrefill({'

# M8b: the PAGE-level freeze is removed, so a store that hands back its own live
# objects passes them straight to the browser client. This is F9's finding.
mutate M8b-list-freezes-out "$OWNER" \
  '      return deepFreeze(page);' \
  '      return page;'

# M9: the coordinator principal may be a human.
mutate M9-principal-must-be-agent "$OWNER" \
  'if (options.coordinatorPrincipal.actorType !== "agent" || options.coordinatorPrincipal.tenantId !== options.tenantId)
    throw new Error("project_orchestration_configuration_invalid");' \
  'if (options.coordinatorPrincipal.tenantId !== options.tenantId)
    throw new Error("project_orchestration_configuration_invalid");'

# M10: a cross-tenant access result is accepted.
mutate M10-cross-tenant-access "$OWNER" \
  'if (result.tenantId !== options.tenantId) throw new WebAccessError("access_denied"); return result;' \
  'return result;'

# M12: a second, different description is admitted under a retained key.
mutate M12-retained-key-blocks-new-body "$BROWSER" \
  'if (pendingDescription && (pendingDescription.projectId !== projectId || pendingDescription.body !== body))
        throw new BrowserRequestError("uncertain");' \
  'if (pendingDescription && pendingDescription.projectId !== projectId)
        throw new BrowserRequestError("uncertain");'

# M13: a retained request no longer disables Prepare proposal (F8's sibling).
mutate M13-retained-disables-submit "$UI" \
  'disabled={pending || !description.trim() || retained}' \
  'disabled={pending || !description.trim()}'

# M16: a decided batch shows suggestion cards.
mutate M16-cards-on-decided-batch "$PIPES" \
  '{!decided && suggestions.map(suggestion => <ChiefOfStaffSuggestionCard' \
  '{suggestions.map(suggestion => <ChiefOfStaffSuggestionCard'

# M17: "Use this" saves the revision instead of only pre-filling. This is the
# mutation that would turn the product promise into a lie.
mutate M17-use-this-writes-revision "$PIPES" \
  'try { const value = await orchestrationClient.useSuggestion(projectId, batchId, suggestion.suggestionId, detail.revision);
      setRevisionReason("chief_of_staff_split"); setRevisionText(JSON.stringify(value.proposal, null, 2)); setRevisionOpen(true); }' \
  'try { const value = await orchestrationClient.useSuggestion(projectId, batchId, suggestion.suggestionId, detail.revision);
      setRevisionReason("chief_of_staff_split"); setRevisionText(JSON.stringify(value.proposal, null, 2)); setRevisionOpen(true);
      await submit(false, true); }'

# M20: any method is allowed on the describe route.
mutate M20-describe-is-post-only "$HTTP" \
  'if (request.method !== "POST") throw new WebAccessError("invalid_request");
        // 200 for every outcome.' \
  '// 200 for every outcome.'

# F1: a hermes-profile option offers the effort 0201 refuses.
mutate F1-effort-default-not-null "$OWNER" \
  'modelKey: profile.name, effort: null }));' \
  'modelKey: profile.name, effort: "default" as never }));'

# F1b: the exact-catalog check accepts anything.
mutate F1b-exact-catalog-check-removed "$OWNER" \
  'if (!draft.success || !offered(draft.data.choice)) throw new WebAccessError("invalid_request");' \
  'if (!draft.success) throw new WebAccessError("invalid_request");'

# F3: an allowance refusal falls back to the catch-all copy and is not announced.
mutate F3-allowance-refusal-copy "$OWNER" \
  'const describeRefusedMessage = (reasonCode: string) => describeRefusalMessageV1[reasonCode]
  ?? "The chief of staff could not turn that description into a safe proposal. Check the wording or settings and try again.";' \
  'const describeRefusedMessage = (_reasonCode: string) => "The chief of staff could not turn that description into a safe proposal. Check the wording or settings and try again.";'

# F3b: the allowance refusal is no longer its own announced status.
#
# The anchor was rewritten for B3. `announced` used to be
# `result.status === "failed" || (result.status === "refused" && result.allowanceRefused)`;
# it is now `(result.status === "failed" && result.needsYou) || (...)`, because a
# first planner failure raises no Needs-you item and must not be announced as one.
# The mutation below removes the ALLOWANCE arm, which is the property F3b is
# about, and leaves the failed/Needs-you arm alone. It used to report a
# SETUP-ERROR here (anchor not found) rather than ESCAPED, which is why the tally
# showed 21/22 with a setup error instead of a clean run.
mutate F3b-allowance-not-announced "$UI" \
  '  (result.status === "failed" && result.needsYou)
  || (result.status === "refused" && result.allowanceRefused);' \
  '  result.status === "failed" && result.needsYou;'

# F4: a stale stored choice is reported as available.
mutate F4-stale-choice-hidden "$OWNER" \
  'choiceStale: !offered(saved.choice), describeAvailable: options.describeAvailable,' \
  'choiceStale: false, describeAvailable: options.describeAvailable,'

# F5: the transport byte bound returns to 32,768, disagreeing with the wire.
mutate F5-body-bound-undersized "$HTTP" \
  'const ORCHESTRATION_BODY_LIMIT =
  PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 * 4 + 64 * 1024;' \
  'const ORCHESTRATION_BODY_LIMIT = 32_768;'

# F6: describe is offered with no planner host.
mutate F6-describe-available-without-planner "$OWNER" \
  'if (!options.describeAvailable) throw new WebAccessError("not_found");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey))' \
  'if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey))'

# F6b: the panel hides itself on a stale selection.
mutate F6b-stale-choice-panel "$UI" \
  'if (settings.choice.mode === "none" || settings.choiceStale) return null;' \
  'if (settings.choice.mode === "none") return null;'

# F6c: Dismiss is offered with nothing to record it in.
mutate F6c-dismiss-without-record "$UI" \
  '{dismissAvailable && <button type="button" disabled={pending} onClick={() => onDismiss(suggestion)}>Dismiss</button>}' \
  '<button type="button" disabled={pending} onClick={() => onDismiss(suggestion)}>Dismiss</button>'

# F8: forgetting a retained request sends it instead of releasing it.
mutate F8-forget-sends-nothing "$BROWSER" \
  'forgetPendingDescription: () => { pendingDescription = undefined; },' \
  'forgetPendingDescription: () => { void commitDescription().catch(() => {}); },'

# F7: describe answers 201 again.
mutate F7-describe-is-201 "$HTTP" \
  'request.headers.get("idempotency-key") ?? "", request.signal), { status: 200, headers: privateResponseHeaders });' \
  'request.headers.get("idempotency-key") ?? "", request.signal), { status: 201, headers: privateResponseHeaders });'

echo
echo "CAUGHT: $pass   ESCAPED/ERROR: $fail"
[ -n "$failures" ] && echo "not caught:$failures"
git status --short
exit $((fail > 0))
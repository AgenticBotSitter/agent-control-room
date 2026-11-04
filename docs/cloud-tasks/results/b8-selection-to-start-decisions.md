# b8-selection-to-start decisions (PLAN)

Choice: Deliver the U81 selection as intake `settingsEdits` (P71 run-edit layer), not by writing the selection layer.
Options: (a) save the P71 selection layer, then intake; (b) run edits at intake.
Why: Preview must create no layer, overrides are run-only (P71 already rejects `overrides` in layers), and saving belongs to U82. Run edits reuse the existing composer, recheck and `recordInputSources` path unchanged. U81 still ships the layer codec U82 will use.
Affected spec item: 2, 3, 5

Choice: Write every B8 member in full on each edit.
Options: partial edits relying on deep merge; full members.
Why: `composeLoopSettingsV1` merges objects key-wise, so a partial slot could inherit a lower-layer key. Full slots and replacing arrays make requested == composed for B8 members.
Affected spec item: 2.2

Choice: Preview eligibility comes only from the checker plus a validated projection; the product never computes families.
Options: product-side family rules from the roster `family` column; checker-only.
Why: The repository keeps rules in the tools (`cr models check`, `cr check lineup`). A second rule engine is forbidden by the task. Missing projection makes preview unavailable instead of guessing.
Affected spec item: 3, 6

Choice: Extend `checkSettings` additively with an optional context, and add an optional `selectionProjection` contract pin.
Options: new checker spawn wrapper; change existing signature; additive optional context + contract pin.
Why: The task forbids a second checker spawn wrapper; the adapter already uses optional contract pins that fail closed when omitted (`decisionProjection`, `recovery`, `finalization`). P71 callers keep identical behaviour.
Affected spec item: 6

Choice: Store the acknowledgement as an optional key `familyRiskAcceptance` in the existing signed claim binding, schemaVersion unchanged.
Options: new table; new binding schema version; optional key.
Why: The signed binding already carries owner/input/hash lineage and is passed to `admissionExpectation`; an optional key keeps legacy rows verifying and needs only additive CHECK changes (precedent: 0306/0307 for `settingsEdits`).
Affected spec item: 4

Choice: Intent is accepted only on intake and Confirm bodies; Start copies the record from the accepted Confirm claim.
Options: intent on Start too; lineage-only reuse.
Why: The task requires reuse only from verified accepted intake/Confirm receipts and preserving the exact timestamp; a Start flag would create a second acceptance moment.
Affected spec item: 4.3

Choice: Add a policy check of the exact saved bytes at Confirm and Start, outside transactions, with relock recheck.
Options: rely on A2 `--expect` only; product check of saved bytes.
Why: The task requires Start to use exact saved bytes and current checks; today only intake checks. The existing intake pattern (check outside tx, `assertSnapshot` under locks) is reused.
Affected spec item: 5

Choice: Preview is a separate POST route without an idempotency key and without writes.
Options: GET with query; POST body; reuse loop-policy PUT.
Why: Loop policy HTTP refuses query strings; selection bodies exceed URL-friendly size; no state changes so no idempotency key; no generic PUT/DELETE allowance.
Affected spec item: 3, 7

Choice: SQL enforces record shape, operation scope and same-row predicates (intake flag ⇔ record, accepted_at ≤ created_at, < 5 s); the service enforces cross-row Confirm reuse and override coupling (r2).
Options: encode reuse lineage in SQL; service only.
Why: Reuse depends on a prior result row and checker outcome, which a row CHECK cannot see. Guard-off tests cover both layers.
Affected spec item: 4.4, 7

Choice: Pre-stamp the acknowledgement record (run id reserved, `accepted_at` = preflight `actor.now`) before the checker runs, and sign the same record in the claim within the freshness window.
Options: stamp inside the claim transaction (checker never sees it); let the override in settings imply acceptance; pre-stamp and bind.
Why: The plan-review helper (HIGH) showed the checker could otherwise only rely on settings bytes, making settings an authority. Pre-stamping lets the checker evaluate the exact signed record; SQL row predicates bound `accepted_at` to `created_at` (≤, < 5 s).
Affected spec item: 4.3, 4.4, 5

Choice: Keep checker `eligible/reasons` unchanged and report product refusals (paid, override origin) as separate `blockers`.
Options: fold product reasons into eligibility; separate blockers.
Why: The task requires one eligibility decision from the checker with unchanged reasons; a second eligibility source is forbidden.
Affected spec item: 3, 2.4

Choice: Pass a checker `lineupDigest` through the additive `admissionExpectation` context rather than a new binding field.
Options: new binding fields for roster/availability digests; expectation context; rely on freshness window only.
Why: Avoids widening the signed binding beyond the one approved record while giving the tools a lock-checked drift fence at spawn.
Affected spec item: 5, 6

Choice: The selection GET projection reads signed lineage only and never spawns the checker.
Options: recompute preview on GET; lineage-only read.
Why: A read path must not run external work or imply authority; Confirm gating compares hashes against the panel's own preview.
Affected spec item: 7

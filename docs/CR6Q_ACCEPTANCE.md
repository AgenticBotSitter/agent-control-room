# CR-6Q fleet and scheduler architecture review

**Status:** Codex adversarial review and remediation complete; independent review remains required before CR-6Q closes.
**Scope:** Effect-free CR-6A through CR-6E contracts and implementation at the recorded review head. This record does not qualify a native host, deployment identity boundary, or live resource.

## Acceptance matrix

| Review area | Evidence | Disposition |
|---|---|---|
| Policy bypass | Scheduler rejects hard exclusions before scoring; Owner Focus produces explicit false authority, fairness, and capacity flags; protected writes require a durable policy decision | Codex pass |
| Starvation and deterministic ordering | One hundred seeded arrival-order cases, one hundred starvation/exclusion cases, named allocation scenarios, and stable tie-breaking | Codex pass |
| Capacity and budget races | Sixteen concurrent one-slot claims produce one winner; reservation and budget heads serialize by tenant/resource or tenant/project; expiry and release are replay-safe | Codex pass after clock fix |
| Platform-status drift | Active enrollment no longer renders as online without fresh usable telemetry; blocked, unavailable, future, and stale signals cannot appear current | Codex pass after projection fix |
| Stale capability evidence | Only passing, trusted, already-observed, unexpired capability records can render provisional or verified; expired passing evidence renders expired | Codex pass after projection fix |
| Isolation | Fleet storage and reads bind tenant/node; the pure eligibility boundary now rejects a mixed tenant/node signal set instead of combining evidence across machines | Codex pass after identity fix |
| Redaction and bounded effects | Secret canaries, unsafe display text, host-private material, browser tenant selection, scheduling overrides, outbox emission, and direct operational controls remain rejected or absent | Codex pass |
| Regression coverage | The normal full-suite command now includes the protected operator API/UI, Owner Focus, target guards, and platform qualification safety tests that it previously omitted | Codex pass after suite fix |
| Independent review | A separate route must review the immutable remediated head and may report only; it cannot repair, approve, merge, or make the final security decision | Pending |

## Closed findings

1. **Mixed-node eligibility evidence.** `evaluateFleetEligibility` trusted a caller to provide one node's signals. Telemetry from one node and capability from another could be combined. The evaluator now returns `signal_identity_mismatch` before evaluating mixed identities.
2. **Expired or invalid capability presentation.** The fleet read model treated any stored capability row as provisional. It now requires a passing outcome, usable trust, an observation no later than the read time, and unexpired evidence; expired passing evidence is explicitly expired.
3. **Administrative state presented as live state.** An enrolled `active` node appeared online even with missing or stale telemetry. It now appears degraded with `telemetry_missing` or `telemetry_stale` until fresh usable telemetry exists.
4. **Future-time acceptance.** A future-granted read scope and a future-starting resource reservation were accepted. Both boundaries now reject a time that has not occurred.
5. **Incomplete default regression suite.** Fourteen effect-free security, protected-API, and operator-surface test files were outside `npm test`. They are now part of the default full suite; rendered HTML remains in the separate post-build check.

## Automated evidence

- `npm run test:cr6q`: 41 passed, 0 failed.
- `npm test`: 339 tests, 337 passed, 0 failed, 2 intentional platform skips.
- Type checking and ESLint pass.
- Production build, rendered-route verification, and migration verification are required again at the final review head.

## Retained gates

- The deployment must establish that `oai-authenticated-user-id` is injected by the trusted platform boundary and cannot be supplied or preserved from an untrusted client. Repository tests cannot prove reverse-proxy or hosting configuration.
- No self-reported fleet signal becomes independently verified. The current operator view therefore reports fresh self-submitted passing probes as provisional.
- CR-6E owner acceptance remains separate and cannot be replaced by automated evidence.
- Native macOS key-store qualification and per-platform supervisor rehearsals remain owner-controlled gates and are not converted into passes by this review.
- The scheduler and reservation ledger remain effect-free planning/accounting components, not live resource acquisition or execution authority.

CR-7 must not begin until the independent reviewer reports a disposition and Codex closes or explicitly retains every finding.

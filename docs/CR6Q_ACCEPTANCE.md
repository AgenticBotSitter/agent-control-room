# CR-6Q fleet and scheduler architecture review

**Status:** Complete. Codex adversarial review, clean independent review, finding disposition, and remediation are accepted.
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
| Independent review | Jobber #157 was claimed through the queue controller by an independent Mac reviewer. PR #158 changed only the authorized report path, passed intake, used pre-existing dependencies without installing, and supplied reproducible command evidence. | Codex accepted |

## Closed findings

1. **Mixed-node eligibility evidence.** `evaluateFleetEligibility` trusted a caller to provide one node's signals. Telemetry from one node and capability from another could be combined. The evaluator now returns `signal_identity_mismatch` before evaluating mixed identities.
2. **Expired or invalid capability presentation.** The fleet read model treated any stored capability row as provisional. It now requires a passing outcome, usable trust, an observation no later than the read time, and unexpired evidence; expired passing evidence is explicitly expired.
3. **Administrative state presented as live state.** An enrolled `active` node appeared online even with missing or stale telemetry. It now appears degraded with `telemetry_missing` or `telemetry_stale` until fresh usable telemetry exists.
4. **Future-time acceptance.** A future-granted read scope and a future-starting resource reservation were accepted. Both boundaries now reject a time that has not occurred.
5. **Incomplete default regression suite.** Thirteen effect-free security, protected-API, and operator-surface test files were outside `npm test`. They are now part of the default full suite; rendered HTML remains in the separate post-build check.
6. **Unbounded signal lifetime.** The signal contract named maximum lifetimes, but an envelope could claim a longer validity window. Schema validation and defensive freshness evaluation now enforce 24 hours for discovery, 5 minutes for telemetry, 7 days for capability, and 30 days for benchmark evidence. The operator projection also rejects overlong legacy telemetry and capability rows.
7. **Replay after reservation termination.** An exact acquire replay could report success for a released or expired reservation, especially after clock regression. Exact replay now succeeds only while the recorded reservation remains active; terminated reservations fail closed as unavailable.

## Automated evidence

- `npm run test:cr6q`: 42 passed, 0 failed.
- `npm test`: 340 tests, 338 passed, 0 failed, 2 intentional platform skips.
- Type checking and ESLint pass.
- Production build and both rendered-route tests pass. Migration verification applies 0001 through 0019 and verifies 66 PostgreSQL tables.

## Retained gates

- The deployment must establish that `oai-authenticated-user-id` is injected by the trusted platform boundary and cannot be supplied or preserved from an untrusted client. Repository tests cannot prove reverse-proxy or hosting configuration.
- No self-reported fleet signal becomes independently verified. The current operator view therefore reports fresh self-submitted passing probes as provisional.
- CR-6E owner acceptance remains separate and cannot be replaced by automated evidence.
- Native macOS key-store qualification and per-platform supervisor rehearsals remain owner-controlled gates and are not converted into passes by this review.
- The scheduler and reservation ledger remain effect-free planning/accounting components, not live resource acquisition or execution authority.

## Independent-review disposition

PR #156 is retained as research evidence only because its reviewer ran an offline install after capsule `CR6Q-REV-001` required a stop before any install. Replacement jobber #157 and PR #158 satisfy the independent-review gate without repeating that deviation.

Codex accepted both substantive findings in PR #158 and remediated them as closed findings 6 and 7 above. The reported telemetry reason-code vocabulary overlap is retained as non-blocking contract hygiene because it demonstrated no unsafe behavior. CR-6Q is closed and CR-7 may begin; retained native, deployment, and owner-acceptance gates remain unchanged.

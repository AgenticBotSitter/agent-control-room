# CR13A-LIVE-240 independent review

**Disposition:** rejected
**Findings:** High 0 / Medium 3 / Low 0
**Review mode:** different independent report-only zero-repair review
**Product:** `b0652b15a944fd51511ab1218c628c5fa347961c`
**Product tree:** `4a105b809c24c6115c0d02bf6685ed26b2f66ea2`
**Design parent:** `3f5f84a4bddd4dd29baed0ef1c766daa2a795585`
**Packet SHA-256:** `f4c1fc670ad498289e873521ae9faf762d8e99410f7617448a52c8ca3c22edf8`

## Reproduced evidence

The different reviewer used a fresh local-only disposable clone with copied prepared dependencies. All twelve fixed
commands ran exactly once in order and passed: clean initial/final status, exact product and tree, whitespace, macOS
stage zero, TypeScript, lint, 10/10 focused tests, all five build phases, 4/4 rendered pages, and migrations 0001-0036/
119 PostgreSQL tables. No install, download, repair, retry, edit, generated executable, native invocation, or external
contact occurred. The disposable root was removed and exact absence was verified.

All tested native, listener, network, persistence, protected-read, wiring, blocker-clearance, eligibility, and authority
values remained zero or false. Those passing facts do not override the following material defects.

## M-001 — failure can defeat the one-use promise and permit re-execution

`runPromise` is assigned only after synchronous execution completes. If execution or status construction throws after
state changes, the promise remains unset and a later `run()` re-enters the state machine. Status construction reaches
ambient-mutable operations inside digest helpers that were not covered by the focused ambient test. A throw followed by
ambient restoration can exceed the declared one-use ceilings. This violates sticky serialized-promise identity and the
no-second-attempt rule after failure or ambiguity.

## M-002 — transition and marker evidence is not append-only

The product stores mutable current state, counters, and flags rather than immutable ordered history. It overwrites the
state and retention flag, changes cleanup from failure to observed absence without preserving a separate failure record,
and does not retain intermediate issuer-retained, transferred, or cleanup-failed transitions. A count alone cannot prove
which transitions occurred or their order.

## M-003 — required pre-claim binding and expiry checks are absent

The product publishes static LIVE-230 identities, but `run()` does not record explicit binding validation or expiry
validation before the claim. It therefore cannot prove the required binding-check, expiry-check, claim, locator-spend,
custody-spend, uncertainty-marker, factory-retrieval sequence.

## Disposition

The exact product is rejected and must not be integrated. Remediation must make the first invocation permanently sticky
before synchronous execution, remove ambient-mutable failure from its execution/status path, preserve immutable ordered
transition and marker history, and explicitly model binding and expiry validation before claim. A new immutable product
and a different independent zero-repair rereview are required.

# CR13A-LIVE-060 remediation re-review

**Disposition:** accepted
**Integration base:** `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`
**Rejected product:** `cee64a8197a011a91c06e6085d5f4d11e978ddbc`
**Remediation product:** `45b4a67477fb39811d02ba1b1a67e8c78cf98ee9`
**Reviewer:** `/root/cr13a_live060_remediation_rereview`, different from the producer and first reviewer
**Mode:** independent, zero-repair, read-only

## Reproduction

All required checks ran from a clean disposable checkout at the exact remediation commit:

- macOS stage zero: exit `0`; `ready_for_runtime_check`; no native attempt.
- `npm run check`: exit `0`.
- `npm run lint`: exit `0`.
- `npm run test:cr13a-transport-admission`: exit `0`; 24/24 passed.
- `npm run test:cr13a-connections`: exit `0`; 53/53 passed.
- `node --import tsx scripts/verify-migrations.ts`: exit `0`; migrations `0001`-`0036` and 119 PostgreSQL tables
  verified.
- Exact base-to-remediation `git diff --check`: exit `0`.
- Disposable checkout remained clean at `45b4a67477fb39811d02ba1b1a67e8c78cf98ee9`.

The remediation product changes only `src/connection-registry/v1/transport-admission.ts` and
`tests/connection-enrollment-transport-admission.test.ts` from the rejected product.

## Finding closure

### M-001 — Closed

The malformed-Promise rejection escape is contained for the safely observable class.

The implementation checks for a non-Proxy value with the exact captured Promise prototype, unchanged native prototype
`constructor` and `then`, unchanged constructor `Symbol.species`, and no own `constructor`. It then invokes the captured
native `then` directly with inert fulfillment and rejection handlers. It never reads a supplied `then`, instrumentation
property, or raw rejection.

The reproduced tests establish:

- zero `unhandledRejection` events for the unreadable-accessor case;
- zero accessor execution;
- a bounded local `integrity_failed` result;
- a strict `--unhandled-rejections=strict` subprocess exiting `0`, with stdout exactly `bounded\n` and empty stderr;
- no foreign thenable or Proxy behavior execution; and
- no execution of replaced prototype constructor, `then`, or species behavior.

Both settlement handlers return `undefined`, so the observer Promise cannot adopt or assimilate the original settled
value and resolves harmlessly.

### L-001 — Closed

The corrected evidence is consistent:

- focused admission/ingress: 24/24;
- complete connection slice: 53/53; and
- posttest total: 304/304, reflecting the two added remediation tests.

The original mistaken 50/50 claim and first reviewer's independently observed 51/51 result remain preserved. The
rejected report remains unchanged with SHA-256
`d53bd172753ee77feb445bedaa0616080a8a74cf302ea12df1058de8454c7342`.

## Findings

### High

None.

### Medium

None.

### Low

None.

## Mandatory closure questions

1. **Pass.** An intrinsic rejected Promise with a non-constructor string data decoration produces only local
   `integrity_failed`; the strict subprocess confirms no unhandled or uncaught process escape.
2. **Pass.** An unreadable instrumentation accessor remains unexecuted, with zero `unhandledRejection` events.
3. **Pass.** The strict child runs the real product outside Node's test runner, clears inherited `NODE_OPTIONS`, installs
   no global rejection listener, waits through the rejection checkpoint, and would exit nonzero if rejection remained
   unobserved.
4. **Pass.** Observation uses captured native `then` only after non-Proxy, exact-prototype, and runtime checks. Foreign
   thenables and Proxies are rejected without reading `then` or executing traps.
5. **Pass.** Own constructor overrides, subclasses, cross-realm values, prototype drift, species drift/accessors, and
   other values outside the safe observation class are untouched. Replacement behavior is not executed and no unsafe
   observer is constructed.
6. **Pass.** Both handlers discard their argument and return `undefined`. The observer cannot carry or assimilate the
   original value and does not become rejected under the admitted runtime.
7. **Pass.** Exact native Promises, inert Node symbol metadata, ingress parsing, response-loss replay, and stable receipt
   behavior remain passing.
8. **Pass.** Counts are corrected to 24/24, 53/53, and 304/304 while preserving the earlier erroneous claim and negative
   51/51 evidence.
9. **Pass.** The remediation changes no request, receipt, proof, failure allowlist, protocol, schema, migration,
   persistence, local-runtime default, route, listener, or external-effect contract.
10. **Pass.** All original questions unaffected by M-001/L-001 remain passing. No new High, Medium, or Low defect was
    found.

## Effects and cleanup

No shared-repository file was modified, committed, pushed, repaired, or checked out by the reviewer. No app, listener,
socket, SSH connection, Hermes/provider call, credential access, production database, deployment, DNS, or network action
occurred.

The disposable checkout used prepared local dependencies and local migration verification only. It was removed
afterward, and its absence was verified. The shared repository remained clean at
`318f5041c894cdc835c206e98fabfeb04a7b7db6`.

This acceptance authorizes architect integration review only. It grants no listener, connection, credential, provider,
production, native-execution, or deployment authority.

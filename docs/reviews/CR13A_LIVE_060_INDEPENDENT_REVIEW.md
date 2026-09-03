# CR13A-LIVE-060 independent review

**Disposition:** rejected
**Immutable base:** `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`
**Immutable product target:** `cee64a8197a011a91c06e6085d5f4d11e978ddbc`
**Reviewer:** fresh independent `/root/cr13a_live060_independent_review`, different from the producer and prior CR13A
reviewers
**Mode:** zero-repair, report only

## Reproduction

- macOS stage zero: exit `0`; `ready_for_runtime_check`; no native attempt.
- `npm run check`: exit `0`.
- `npm run lint`: exit `0`.
- `npm run test:cr13a-transport-admission`: exit `0`; 22/22 passed.
- `npm run test:cr13a-connections`: exit `0`; 51/51 passed.
- `npm run db:verify`: exit `1`; the sandbox denied the `tsx` CLI's attempted local Unix IPC socket with
  `listen EPERM`.
- Equivalent listener-free execution, `node --import tsx scripts/verify-migrations.ts`: exit `0`; migrations
  `0001`-`0036` applied and 119 PostgreSQL tables verified.
- `git diff --check 5a94bfd7f28d336274f6b29ad50575eb5a90a9b1..cee64a8197a011a91c06e6085d5f4d11e978ddbc`:
  exit `0`.
- Private rejected-Promise probe: exit `0`; output was
  `{"safeCode":"integrity_failed","unhandledRejectionCount":1,"rawRejectedValueEscapedToProcessEvent":true}`.

The exact `db:verify` command failure is preserved as negative evidence. It cannot support acceptance even though the
listener-free equivalent verified every migration.

## Findings

### High

None.

### Medium

#### M-001 — Rejected malformed native Promise escapes through the process-level unhandled-rejection channel

Evidence: `src/connection-registry/v1/transport-admission.ts:307-309` in the immutable product.

When ingress returns a native Promise that violates the admission shape, such as an already-rejected intrinsic Promise
decorated with one own string instrumentation property, `exactNativePromiseV1` rejects it and admission returns a fresh
`integrity_failed`. No rejection handler is attached to the original Promise.

The private probe confirmed that the caller receives `integrity_failed` while the original raw rejected value is emitted
through the process `unhandledRejection` event. Under stricter Node rejection policy this can terminate Control Room.
With a global handler, the raw value can reach logging or other process-wide behavior. This contradicts raw-failure
containment. It requires a malformed in-process ingress result rather than a remote frame alone, so severity is Medium.

Required remediation: harden the async handoff so every rejected native Promise within the safely observable admitted
class is consumed without reading or assimilating a foreign thenable, Proxy, subclass behavior, accessor, or
caller-controlled `then`. Add a strict unhandled-rejection regression proving that a decorated rejected native Promise
creates no process event, the raw rejection does not escape, foreign thenables/Proxies still execute zero behavior, and
the caller receives only bounded local integrity failure.

### Low

#### L-001 — Acceptance evidence records the wrong connection-suite count

Evidence: `docs/CR13A_LIVE_060_BOUNDED_TRANSPORT_ADMISSION_ACCEPTANCE.md:78` in the review documentation.

The document states 50/50 while exact target reproduction reports 51/51. Update the durable evidence count and duplicate
status references to the observed result.

## Mandatory attack questions

1. **Pass.** The request accepts exactly enumerable own data properties `rawFrame` and `deliveryId`. Caller chronology,
   authentication, enrollment, tenant, node, connection, credential, route, approval, and authority fields are rejected.
2. **Pass.** Exact validation and UTF-8 byte counting occur before clock and ingress. The ceiling is 4,096 through
   `NODE_PROTOCOL_MAX_FRAME_BYTES`, inclusive, and multibyte overflow is covered.
3. **Pass.** `receivedAt` originates only from the captured synchronous clock, is canonical UTC, and the final receipt
   uses ingress's original durable time. Exact replay stays stable when the retry clock advances.
4. **Pass.** Rate-limit identity derives only from the frozen admission-policy and channel-identity digests. Frame and
   delivery hint do not contribute. The receipt exposes no raw preimage or derived transport identity.
5. **Pass.** Only `ssh_tunnel` and `private_loopback` are accepted. They are policy claims, not physical bind evidence or
   listener authority.
6. **Fail.** Proxy, accessor, subclass, foreign thenable, own-string, prototype-mutation, and error-mapping defenses mostly
   close, but M-001 proves a rejected malformed native Promise can escape raw through the process-level event channel.
7. **Fail.** The pre-`await` test prevents foreign thenable assimilation and tolerates symbol metadata, but it does not
   safely consume a rejected native Promise that fails the own-string rule. M-001 is the availability/raw-escape defect.
8. **Pass.** Ingress errors preserve only the exact-prototype, own-data, explicit safe-code allowlist. Unknown values
   become a fresh `integrity_failed` without `instanceof`, inherited reads, serialization, logging, or direct rethrow.
9. **Pass.** The strict receipt is digest-bound, replay-stable, free of raw protected identifiers, and explicitly denies
   listener, I/O, approval, network, command, lease, and execution authority.
10. **Pass.** The database path revalidates routing against protected delivery evidence and preserves separate outer
    node-frame and inner enrollment-signature verification.
11. **Pass.** Local runtime installs only disabled admission. No application mutation route, socket, bind,
    SSH/Hermes/provider/native action, credential access, production database/VPS contact, deployment, DNS, or network
    effect was found.
12. **Pass for prior accepted contracts.** No migration, schema, node-protocol, or persistence change was added. No
    weakening of LIVE-030/040/050 authentication, replay, redaction, persistence, or negative authority was found. M-001
    is confined to the new admission seam.

## Effect and cleanup confirmation

No product file was changed, committed, pushed, or repaired by the reviewer. The shared repository remained clean.
Testing used an archived disposable copy with prepared dependencies and in-memory PGlite only. No application or
external listener was successfully bound; the `tsx` IPC attempt failed with `EPERM`. No SSH, Hermes/provider, credential,
production PostgreSQL, VPS, deployment, DNS, or external network action occurred. The disposable directory was removed
and its absence verified.

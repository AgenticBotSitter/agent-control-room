# Actual etcd service: CAS, restart and scoped-role comparison

2026-09-08, Control Room8352d3e. Actual official etcd3.7.1 Darwin/arm64 binary,
release source5e7fd0de9a57db03ecc11794dc40403a734c07bb. **Eight bounded observations
passed, including negative evidence that an exact-key WRITE role can delete its key.**
This is E2 service behavior, not a completed Control Room checkpoint adapter comparison.

## Executed versus assumed

`research/reuse-comparisons/f5-etcd-service-fit.mjs` starts one owned etcd process
with explicit loopback client/peer endpoints and a fresh disposable data directory.
HTTP JSON gateway requests execute real etcd transactions and authentication/RBAC.
The two racing transactions compare the same exact initial bytes, have different
success values and empty failure branches. Exactly one succeeds; a later stale
comparison does not. Restart preserves the complete returned KV record, including
value and revision metadata, not just an application counter.

The payload is an authored synthetic scope/revision object, **not** a parsed
RollbackCheckpointV1. No production adapter, SQL transaction, signing key or live
approval is involved. The fixture does not call a native agent or provider.

Owner setup creates a fixture root and a restricted runtime identity, using an
in-memory random test password. Only the runtime identity receives exact-key
READWRITE. After auth is enabled, its own-key read succeeds, a neighbor read is
denied and role administration is denied. Its DeleteRange on the allowed key
nevertheless succeeds and the subsequent range is empty. Therefore exact-key
RBAC must not be advertised as delete-denied or monotonic-only. No tokens/passwords
or raw server logs are retained in evidence.

## Failure, correction and process/resource evidence

The initial attempt reached three CAS observations but failed the harness assertion
that requested SIGTERM must return exit code0. The owned process actually terminated
with `{code:null,signal:"SIGTERM"}`. Its data was removed and the failed receipt is
retained separately in `f5-etcd-service-initial-failure.json`.

One focused harness correction permits only zero exit or the requested SIGTERM as
terminal for the restart experiment; SIGKILL and spawn failures still fail. This
does **not** relabel a signal exit as graceful shutdown. The corrected run completed
eight observations, both processes terminated with SIGTERM, and state cleanup
completed. No process is waiting, and no automatic write retry was used.

The actual runtime receipt is `f5-etcd-service-evidence.json`. Highest sampled server
RSS was32,656KiB; sampling every250ms may miss peaks. This excludes the Node harness
and is not production cluster sizing. The earlier failed run sampled30,016KiB and
is not combined as another passing workload. GOMAXPROCS2, Go memory target128MiB,
16MiB backend quota,64KiB request cap,90-second process lifetime, per-request deadline
and sampled256MiB kill threshold bound this disposable workload. A Go target and
sampled watchdog are not a hard OS memory limit. Two-second client requests read
bounded expected responses; response length is checked after buffering.

## Acquisition and cleanup

Official release metadata and archive checksum were verified before extraction;
the harness rechecks the actual executable hash before launch. See
`f5-service-acquisitions.json` and `f5-release-source-refresh.md` for hashes/pins.
Both etcd and the not-yet-executed OpenBao distribution total352,512KiB in one
owned root, with139GiB initially free. No install scripts, package-manager changes,
global configuration or existing services. GitHub release checksums are provenance
evidence, not independent signing-key verification or full license clearance.

Each execution's exact newly created state directory was removed after observed
process termination. Candidate distributions remain intentionally retained for the
remaining comparison; the acquisition ledger names their exact cleanup target.
No persistent service registration or public listener exists.

## What this changes and what still needs testing

This advances the former source-only etcd CAS/deletion distinction to real service
evidence. OpenBao remains a viable alternative whose narrower operation permissions
must be exercised, not assumed from its ACL source. No final winner or production
deletion is earned by this packet.

Remaining common cases: actual CR adapter/payload and scoped scope/digest/revision
validation; dropped successful-write response and no repeat; unavailable/missing
anchor refusal; key replacement detection against provisioned pins; supported
snapshot restore; and staged SQL commit failure after anchor advance. Cross-store
rollback/independent custody still requires its own evidence. A successful local
restart is not backup restore or an independent disaster domain.

[Independent review](f5-etcd-service-review.md) found no blocking contradiction for
these observations. Important next-case constraints: CAS/restart occurred before
auth setup, so scoped-token CAS and authenticated restart remain untested; actual
denials were403, but future policy assertions should require permission-denied
rather than any error. Root also checked the retained distribution root contains no
`etcd-state.*` directories after both runs. The review's released-port race and
post-extraction validation limitations remain: this is a pinned isolated fixture,
not an adversarial-host endpoint or untrusted-archive security qualification.

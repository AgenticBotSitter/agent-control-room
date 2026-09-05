# CR14C — current native lease evidence from durable signed delivery

Date: 2026-09-05. Repository composition only, based on PR #303.

`createNativeLeaseEvidence` resolves the start controller's existing VerifiedLeaseAuthority input from
an exact initial `job.lease.grant` message, not an arbitrary lease object. It uses caller-owned bridge
journal and server trust resources; construction opens nothing and has no default trust provider.

## Evidence chain

1. `acceptedCommand` reads both the command payload and replay-consumption receipt in one existing
   SQLite transaction. Message, canonical full-frame digest, connection, sequence, nonce digest,
   received time and envelope expiry must agree. Missing half-records and corrupt projections fail.
2. Parse the existing signed protocol schema, require server-to-node/control-room direction, exact
   configured server actor and tenant, initial grant type, and independently compare body digest.
3. Resolve the current active server key through ServerTrustStore and verify the actual frame signature.
   SqliteNodeSecurityStateRepository implements this using owner-pinned signed bundles and anti-rollback
   state. A record on disk alone is not proof of a valid or still-trusted signature.
4. Require receipt within the signed envelope's validity and no future receipt; this reader deliberately
   accepts no receipt-before-sent clock-skew allowance. Once validly received, envelope expiry is not
   lease expiry: current authority is bounded by the actual grant/authority deadlines.
5. Check exact request node/job/attempt/lease/epoch/authority/project and authority content digest.
   Re-read the current exact local attempt summary after awaiting trust. Only leased/running/waiting
   with the same lease/epoch remains eligible. Terminal or superseded summaries deny.
6. Re-read the immutable accepted receipt after the await; changed evidence denies. Return copied lease
   material. The existing local evaluator still owns parent digest-chain/ceiling/request intersection,
   owner approval and current admission; this reader does not grant execution by itself.

Revocation through the current owner-signed server bundle invalidates a previously received grant.
Offline use cannot learn an unseen owner revocation; no stronger delay claim is made. The caller's
bounded start controller supplies timeout/concurrency limits and a trustworthy clock. Abort is checked
before/after asynchronous trust resolution; no journal write, renewal or marker occurs here.

## Durable integration boundary

`attemptSummary` is an exact-key read of the existing bridge attempt table, not a second lease table.
The trusted dispatch handler must save the received command and current attempt before using this
reader. The existing generic bridge handler may handle a message without retaining command payload;
such a partial record is intentionally insufficient here. This block does not install a new handler
or change receive/acknowledgement order. It handles one already-approved initial native task; renewal
messages cannot silently extend its payload-bound deadline. Lease replacement requires new task authority.

The bridge receipt and attempt summary are trusted local journal state, not tamper-proof against a
same-UID attacker rewriting all records. The full-frame signature and owner-pinned current trust are
independently checked, while previously accepted sequence state still comes from the existing replay
guard. No new schema, platform credential read, native connection or production database is involved.

## Test and remaining boundary

Tests use the real disposable owner-pinned security repository, signed trust-bundle updates, signed
protocol grants, replay/command journals, canonical task assignment and start controller with fake
transport. They cover actual owner-countersigned last-key replacement/revocation, forged signatures,
partial/corrupt receipts, terminal/superseded attempts, expiry, abort and state changes during trust reads.

Other current evidence sources remain: owner approval trust/custody, current ceiling/pause/key/profile
composition, native qualification and destination enforcement. Owner approval issuance/intake, signed
coordinator dispatch and bounded revisions remain C-WORK requirements. No runtime activation or full
C-WORK completion is claimed. Continue Astra Medium.

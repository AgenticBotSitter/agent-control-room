# CR12B-IDEA-090 durable live-panel authority acceptance

**Status:** Complete for the exact repository-only, provider-disabled snapshot. No native attempt or provider call
occurred.

## Accepted authority boundary

One PostgreSQL-compatible append-only authority ledger now records three distinct facts:

1. an architect-key-authenticated decision accepts or terminally revokes one exact native qualification receipt;
2. a separately keyed server admission decision seals or terminally revokes one exact admission, owner window, session,
   run, runtime, and receipt binding; and
3. one atomic consumption binds that exact admission/window/run before the protected coordinator can contact its injected
   driver.

Receipt acceptance binds the exact runtime and adapter versions/revisions, compatibility evidence, runtime manifest,
protected-value custody evidence, architect identity, independent review, and strong-factor evidence. Possessing a digest
alone cannot create acceptance. Admission sealing binds the exact owner decision and strong-factor evidence but grants
neither project creation nor general execution authority.

The same admission and run may replay inertly after consumption. It creates no second row and the coordinator's durable
run ledger makes no second panel call. A window, admission ID, admission digest, or run cannot be reused for another
binding. Receipt and admission revocation are terminal; neither may be reaccepted or resealed.

## Integrity and rollback behavior

Every row forms a revision-ordered, HMAC-authenticated digest chain. SQL triggers reject update, delete, and truncate.
Partial unique indexes enforce one consumption per admission, window, and run and one seal per admission ID and run.

An independent compare-and-swap high-water checkpoint authenticates the complete ordered record-digest set outside the
protected database. The checkpoint advances before database commit. A database commit failure therefore fails closed;
restoring or deleting database history while retaining the checkpoint is detected on the next read. Missing, stale,
forged, or mismatched checkpoint state is never treated as an empty authority registry.

## Verification

- New hostile authority-store suite: 12/12 passed.
- Combined CR12B suite: 81/81 passed.
- The complete registered `npm test` lifecycle passed with zero failures.
- TypeScript, full repository lint, production build, whitespace validation, and macOS stage-zero readiness passed.
- All 3 rendered route checks passed, including Idea Lab and its promoted project workspace.
- All 31 migrations recreated and verified 109 PostgreSQL tables in the disposable verification database.
- Cases cover exact consume/replay, protected coordinator integration, concurrent duplicate consumption, cross-run window
  reuse, terminal receipt/admission revocation, wrong architect/admission keys, append-only SQL guards, privileged
  rollback, restart recovery, Proxy rejection without traps, and absence of native/provider composition.
- PostgreSQL migration `0031_cr12b_live_panel_authority.sql` creates the ledger, partial uniqueness constraints, and
  append-only guards.

## Effects not performed

The store and migration are unconfigured in every shipped application composition. No native runtime/profile/workspace,
protected value, provider, process, filesystem, network, production PostgreSQL/VPS, deployment, DNS, or hosting effect
was touched. No native qualification receipt is accepted in repository defaults.

## Remaining gate

IDEA-100 must freeze the exact owner-ready native qualification and first-live-panel rehearsal packet. It must bind the
accepted driver, authority store, Hermes 0.21 compatibility evidence, disposable resources, zero tools/MCP, sanitized
receipt, independent review, and a separate later owner effect window. Building that packet remains effect-free. Native
or provider contact still requires a fresh, exact owner authorization after the packet is accepted.

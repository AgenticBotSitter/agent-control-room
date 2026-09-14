# Security and recovery fault matrix

This package is repeatable, synthetic, and effect-free. It exercises the production completion-store, etcd checkpoint access/parsing/CAS, artifact inventory comparison, owned owner signer, and paired approval issuer through injected in-memory transports and disposable database fixtures. It creates no persistent key, service, credential, artifact, native process, or production claim.

## Covered outcomes

| Boundary | Faults | Required result |
| --- | --- | --- |
| Completion database / checkpoint split | checkpoint ahead after lost acknowledgement; database ahead of stale checkpoint | Fresh clients and repeated inspection refuse reads, writes, and provisioning; SQL and checkpoint mutation counts do not increase. |
| Checkpoint record | same revision/count with changed digest or tag; missing/replaced key; wrong scope, cluster, or create revision | Exact production record parsing and completion-store verification refuse before mutation or initialization. |
| Checkpoint update | failed comparison, timeout, abort, late acknowledgement | One or zero dispatch as appropriate, no retry, no cleanup or rollback mutation, and no SQL commit. |
| Owner signing | unavailable signer, wrong signing identity, cancellation, timeout/late response | The owned channel closes once, the one-use signer cannot retry, and late results cannot become signatures. |
| Current owner authority | consent becomes revoked after the first member of the paired approval signatures | The actual paired issuer refuses the whole packet, emits no second signature, and cannot retry. |
| Artifact metadata | missing, extra, content/header, manifest, or receipt mismatch | Exact supplied inventories refuse. An exact match says only that synthetic metadata matched; it does not verify restored bytes. |

Run `pnpm test:security-recovery` from an already prepared checkout. The registered
lane covers both focused fault-matrix files and is included by `pnpm test:components`.
The adjacent repository lanes remain `pnpm test:owner-signing`,
`pnpm test:checkpoints`, and `pnpm check:demo`.

## Scope and interpretation

Mutation assertions query the actual completion tables before and after refusal and count the real checkpoint transport calls. Restart means constructing a fresh production store over retained disposable SQL and peer state; it is not a physical database or etcd restart.

Artifact inventory verification compares caller-supplied canonical metadata only. It does not read storage, restore bytes, authenticate backup custody, initialize checkpoints, repair split state, grant authority, complete work, or release capacity.

Owner signing uses ephemeral test keys and an in-memory protocol. Current consent revocation is exercised through the issuer's existing synchronous authority fence. Physical signer custody, operator presence, native endpoint permissions, and real revocation propagation remain qualification work outside this package.

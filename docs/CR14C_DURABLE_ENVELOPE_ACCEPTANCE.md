# CR14C durable signed envelope evidence

Date: 2026-09-05. Accepted product: `3e34d71e95f2ea86cda26a7227af3a0a51223f6a`.
Tree: `47de7084fb4834d3ad16984412a50e1b67b7a7ec`.
Base: `39b25df358113cbc49a5ab6e996550313aeea773` (PR #319).

The real canonical coordinator and server session now stage one exact signed native dispatch envelope
under the checked approval transaction. The source is the persisted, HMAC-verified body, not a newly
reconstructed payload. Canonical node/key, owner packet, session, expiry and commit fences participate.
The session reserves the sequence without sending; immutable envelope and audit commit together.

Independent review accepted this exact product with no findings. The permitted command exited zero:

```sh
node --import tsx --test tests/native-delivery-envelope.test.ts tests/server-node-session.test.ts tests/web-database-roles.test.ts tests/web-fixture-preparation.test.ts
```

52 passed, zero failures/skips. The initial eight envelope checks passed; the expanded set adds node-key
expiry, missing queue and historical HMAC/input verification. Other cases verify an actual signed frame,
no transmission, replacement-session duplicate refusal, cancellation/trust/expiry/disconnect rollback,
lost-commit reconciliation, exact audit, restricted-role staging and immutable/web-inaccessible history.
Tests use real disposable canonical SQL, SQLite bridge journals, separate synthetic node/server/owner
keys and actual signed handshake before staging. No production resource is attached.

Migration0050 adds one immutable table (136 total), with coordinator SELECT/INSERT only. The disposable
schema fingerprint is `797e11e174de3dbac425f714d2f2c4a405b24b4fce8c39982b4d15a72250b758`;
explicit fixture manifests and role preflight are updated. No earlier failures or review corrections
occurred in this block. TypeScript, full ESLint and whitespace passed before independent review.

This is not transmission, a native receipt, permission to run or proof of execution. There is no native
send method, HTTP/lifecycle mounting, owner key loader, listener, provider call, deployment or merge.
Transmission attempt/receipt persistence and node intake/admission remain next. Historical readback
after uncertainty must not be used to re-sign or automatically send a second envelope.

Final immutable-product checks exited zero: CR14C477, preparation769, main1061 with two existing
platform skips, post-suite392. Both application builds,18 private compiled checks,four rendered-page
checks,TypeScript,full ESLint,stage zero,whitespace and migrations0001–0050/136 tables passed.
Only documentation changed after the independently accepted product during final verification.

Published as [PR #320](https://github.com/MarvinAi5/control-room/pull/320), stacked on #319.
Current-head GitHub CI remains required; no merge or deployment is claimed.

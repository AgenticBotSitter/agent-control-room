# CR14C durable delivery preparation evidence

Date: 2026-09-05. Accepted product: `9101304739f18cb17b976b56cec098a414dcd5e0`.
Tree: `2a277d80bae6b89b837b639d97e0f0c3b8913dc0`.
Base: `db52fc67aea4f97120cf2ee48312aedcc068ab42` (PR #316).

The coordinator persists the exact native dispatch body only after current canonical/owner/signature
revalidation and HMAC-verified queue matching, with its audit in the same checked transaction. It does
not sign a server envelope or send a message. Historical readback exposes only receipt digests and time.

Producer command passed36 tests, exit zero:

```sh
node --import tsx --test tests/native-delivery-preparation.test.ts tests/web-database-roles.test.ts tests/web-task-startup.test.ts
```

Initial run passed35 and failed one replay assertion: canonical revalidation advances occurredAt, so
whole-body equality incorrectly refused an unchanged task. The fix compares all other content/permission
fields while retaining the first exact stored body, and rejects an original timestamp outside queue-time
to current-time bounds. This does not refresh execution authority or change the stored body digest.

Other cases cover missing queue, commit expiry/cancellation/trust rollback, lost acknowledgement,
historical read after expiry/pin closure, wrong input, queue/body HMAC tampering, restricted coordinator
preparation, web denial and immutable history. Initial TypeScript and focused ESLint passed.

Migration0049 adds135th table, foreign keys and immutable triggers. The disposable structural fingerprint
is `a2633202d45bdf6a6e287ca25ea0e92d68802c659afd9164957683d50ad319c1`; explicit preparation manifest and
coordinator-only SELECT/INSERT profile are updated without widening web access. Both builds,18 private
compiled checks,four rendered routes,migrations0049/135 tables,TypeScript and full ESLint passed.
The retained full lifecycle wrapper exited zero: CR14C457, preparation769, main1036 passed with two
existing platform skips, and post-suite392. Stage zero and whitespace passed. Only documentation
changed after the reviewed product; no further product corrections occurred during final verification.

Independent review accepted the exact product with no actionable findings. This command passed74 tests
with zero failures/skips, exit zero:

```sh
node --import tsx --test tests/native-delivery-preparation.test.ts tests/native-task-queue.test.ts tests/native-delivery-protocol.test.ts tests/web-database-roles.test.ts tests/web-task-startup.test.ts tests/web-fixture-preparation.test.ts
```

No credentials, native/provider call, listener, live database, deployment or merge. No HTTP/lifecycle
mounting, negotiated channel, server signer, actual send or durable node acknowledgement is implemented
in this block. Stored unsigned body is not delivery evidence or current execution permission.

Published as [PR #317](https://github.com/MarvinAi5/control-room/pull/317), stacked on PR #316.
Current-head GitHub checks remain required before dependency-order integration; no merge is claimed.

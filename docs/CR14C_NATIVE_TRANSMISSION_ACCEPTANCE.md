# CR14C native transmission intent evidence

Date: 2026-09-05. Accepted product: `6ad15ff023c35a7ef2293a95ea0e6e7fa4eee97e`.
Tree: `1edd82d4e2936e2be405cba47e3d655e9a5f7d91`.
Base: `62a633c31a846944f17bbe1ed1b579d7cc2f2cde` (PR #320).

The actual coordinator/session integration now commits immutable transmission intent and audit before
entering a supplied synthetic transport exactly once with the original signed frame. Current canonical
approval/key/deadline and local trust/cancel/session fences remain required. Returned transport status
is explicitly unconfirmed; no native receipt or execution is inferred.

Independent re-review accepted the corrected product with no remaining blocking findings:

```sh
node --import tsx --test tests/native-transmission-intent.test.ts tests/native-delivery-envelope.test.ts tests/server-node-session.test.ts tests/web-database-roles.test.ts
```

Exit zero:50 passed, zero failures/skips. Cases include commit-before-send and exact frame identity,
pre-commit rollback, post-commit cancellation, lost commit acknowledgement, transport rejection,
unresolved-send timeout, concurrent/later retry refusal, immutable history, web SQL denial, HMAC
verification, and identity/verification/stored-session/grant expiry after commit but before send.

Negative evidence retained:

- Initial product `eb380fe` passed45 review checks, but its pre-send closure omitted the locked web
  authorization snapshot's time windows. Shared `WebActor.assertTimeCurrent`, copied identity and
  a retained coordinator closure now check those windows immediately before transport entry.
- Initial expiry regressions tried mutating frozen verified identities and failed. The tests now use
  independent assertion copies and preserve the production identity's immutability. No gate was relaxed.
- An earlier broad run passed while corrections were being made; it is not final-product evidence.

The retained time fence is not a new post-commit database revocation poll. Existing authorization-lock
ordering remains; required captured policy windows are reevaluated, while subsequent database changes
are not represented as continuously observed. No browser/lifecycle mounting or live credential/transport
is configured. The agent native intake/admission and authenticated receipt pipeline remain unimplemented.

Migration0051 adds the137th table, an envelope foreign key, immutable triggers and coordinator-only
SELECT/INSERT. Schema digest: `f86730c7e0047bc44c346cde2c58f8bce19371f75951f7c9fc8067fc88be7732`.
Final frozen-product lifecycle verification exited zero: CR14C494, preparation769, main1078 with two
existing platform skips, post-suite392. Both application builds, private compiled18, rendered4,
migrations0051/137 tables, TypeScript and full ESLint passed. The original build process handle had
already closed when context was recovered; the build batch was rerun and its terminal results observed.
No provider/native calls, physical listener, real database service, deployment or merge occurred.

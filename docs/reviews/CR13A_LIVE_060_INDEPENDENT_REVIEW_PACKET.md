# CR13A-LIVE-060 independent bounded transport-admission review packet

**Mode:** independent review, report only
**Immutable base:** `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`
**Immutable product target:** `cee64a8197a011a91c06e6085d5f4d11e978ddbc`
**Producer:** root Codex architect; reviewer must be different from the producer and prior CR13A reviewers
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact target safely admits one already-decoded private-tunnel frame into accepted LIVE-050 ingress
without trusting transport input for chronology, identity, authentication, enrollment, or authority; without executing
hostile values across synchronous/asynchronous seams; and without opening a listener or creating an external effect.

## Exact scope

Review exactly:

```text
git diff 5a94bfd7f28d336274f6b29ad50575eb5a90a9b1..cee64a8197a011a91c06e6085d5f4d11e978ddbc
```

Principal paths:

- `src/connection-registry/v1/transport-admission.ts`
- `src/connection-registry/v1/node-ingress.ts`
- `src/connection-registry/v1/index.ts`
- `src/local-pilot/v1/runtime.ts`
- `tests/connection-enrollment-transport-admission.test.ts`
- `tests/connection-enrollment-node-ingress.test.ts`
- `package.json`
- `docs/CR13A_LIVE_060_BOUNDED_TRANSPORT_ADMISSION_ACCEPTANCE.md`
- ADR-155 in `docs/CR3_DECISION_LOG.md`

Treat producer tests and documents as claims to attack, not acceptance evidence. Prior LIVE-030/040/050 review evidence
remains authoritative only where the target did not change those contracts.

## Mandatory attack questions

1. Does the request accept exactly `rawFrame` and an untrusted `deliveryId`, with no caller chronology, authentication,
   enrollment, tenant, node, connection, credential, route, approval, or authority field?
2. Is exact input validation and UTF-8 byte-length enforcement complete before the clock or ingress can run, including
   multibyte strings and the accepted protocol maximum?
3. Is `receivedAt` supplied only by a synchronous server-owned clock, canonicalized exactly, and unable to drift on an
   exact response-loss replay whose ingress result has an earlier durable time?
4. Is transport rate-limit identity derived only from frozen server policy plus a digest-only channel identity, never a
   frame, routing hint, or other request-controlled identity? Can the receipt disclose its protected preimage?
5. Are the only accepted configuration claims `ssh_tunnel` and `private_loopback`, and is it clear that these claims do
   not prove a physical listener's bind address or authorize/open any listener?
6. Can a Proxy, accessor, Promise subclass, foreign thenable, own string property, intrinsic Promise prototype mutation,
   synchronous throw, rejected value, or post-import runtime replacement execute behavior, bypass the boundary, escape
   raw, or create a misleading safe code?
7. Is the accepted ingress Promise test strong enough to reject thenable assimilation before `await` while still
   tolerating only inert Node test-runner symbol metadata? Can a rejected invalid Promise become an unhandled effect?
8. Does every ingress failure preserve only a declared explicit safe-code allowlist and map every unknown value to fresh
   conservative integrity failure without `instanceof`, inherited reads, serialization, logging, or raw escape?
9. Is the admission receipt strict, digest-bound, replay-stable, secret-free, and explicit that it opens no listener,
   performs no network I/O, and grants no approval, network, command, lease, or execution authority?
10. Does LIVE-050 still revalidate the untrusted delivery hint against authenticated protected evidence and preserve
    independent outer node-frame and inner enrollment-signature proofs on the full database-backed path?
11. Is the local runtime genuinely disabled, with no new API/browser mutation, socket, bind, SSH/Hermes/provider/native
    action, credential access, production PostgreSQL/VPS contact, deployment, DNS, or network effect?
12. Did the target change any protocol/schema/migration/persistence semantics or weaken accepted LIVE-030/040/050 runtime
    custody, replay, redaction, failure, or negative-authority behavior?

## Required reproduction

Run from a clean checkout at the immutable product target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-transport-admission
npm run test:cr13a-connections
npm run db:verify
git diff --check 5a94bfd7f28d336274f6b29ad50575eb5a90a9b1..cee64a8197a011a91c06e6085d5f4d11e978ddbc
```

The reviewer should add private read-only probes or temporary tests outside the shared product tree when needed. Do not
edit the shared checkout. Do not start the app, bind a listener, open SSH, contact Hermes/provider/production PostgreSQL,
read credentials, deploy, or publish protected host/infrastructure evidence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_060_INDEPENDENT_REVIEW.md`. Include:

- exact base and product target;
- reviewer independence statement;
- reproduced commands and exact outcomes;
- findings ordered High, Medium, Low, each with file/line evidence, exploit/failure path, and required remediation;
- explicit answers to all twelve mandatory attack questions;
- confirmation that no product file changed and no external effect occurred; and
- one disposition: `accepted` only if there are no High, Medium, or Low findings, otherwise `rejected`.

Negative evidence is durable. A failed command, incomplete review, or uncertainty cannot be converted into acceptance.
The report grants no integration, listener, enrollment, connector, native, provider, production, or deployment authority.

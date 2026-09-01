# CR12B-IDEA-110F — macOS Hermes connector candidate

**Status:** Preserved rejected candidate. Independent jobber #211/PR #212 returned `remediation_required` with two High
and three Medium findings. The immutable report SHA-256 is
`d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808`; remediation is in IDEA-110G.

## Outcome

Control Room now has the Mac-side protocol guard that binds the reviewed fixed bridge to one injected private Hermes
Desktop port. The private port remains the sole owner of local/SSH connection registration, hostnames, usernames, ports,
key selection, protected values, gateway endpoints, profile paths, and native session identifiers. The connector sees
only the signed opaque route, attempt, permit, identity, lease, and source-manifest digests allowed by ADR-140.

This is a real connector-boundary implementation, not a live connection. No private port is configured by default. This
block did not start Hermes, launch SSH, access Keychain or another credential store, contact a gateway/provider/network,
write outside the repository, create an enrollment, or grant execution authority.

## Implemented boundary

- One connector instance accepts one route-open attempt and can never retry it.
- Exact descriptor-based capture rejects request accessors, unknown/inherited properties, symbols, non-ordinary data,
  and Proxies before private dispatch.
- Concrete private-port methods retain their receivers.
- The only ordinary operation order is create, prompt, replay, status, and usage. Cleanup is interrupt, status, close,
  then route close. Arbitrary operations and parameters are absent.
- Attempt, permit, route, lease, profile, conversation, runtime, and source-manifest bindings are rechecked.
- An uncertain open becomes close-only. An uncertain operation becomes cleanup-only. Neither can retry.
- Concurrent route close aborts the active call, waits for it to settle, and only then enters private cleanup.
- A known created session cannot bypass at least one cleanup attempt before route close.
- Returned top-level receipts are exact-captured, reject extra locator fields and behavioral objects, and prove zero
  retained native references on successful close.
- The shipped composition remains frozen with no port, signer, route, native attempt, SSH connection, provider call, or
  authority configured.

## Verification

Nine focused hostile tests cover the complete lifecycle, operation/parameter/binding/order rejection, cleanup-bypass
denial, uncertain-open reconciliation and no retry, concurrent abort/settlement ordering, receiver preservation,
accessor/Proxy and locator-bearing receipt rejection without behavior, disabled composition truth, and source-level absence of process, filesystem,
network, SSH, credential, and Hermes clients. TypeScript and full lint pass; the combined Idea Lab suite passes 149/149;
the complete lifecycle passes 769/769 pretests, 414/416 core tests with two intentional platform skips, and 228/228
posttests. The production build, 3/3 rendered routes, all 32 migrations with 110 PostgreSQL tables, macOS stage zero, and
whitespace validation also pass.

## Independent result

The implementation is frozen at commit `70f5890b3be5162896a585dae458a9a9c02e8036` and was attacked against packet
SHA-256 `59e79825dd1b537f8388ae4a7bf429a523d1c3d9256d403c7aef5b690a7d7b2f`. Producer tests did not set
`connectorImplementationAccepted`, and the independent result did not configure the private port, enroll a signer or
route, refresh the owner packet, authorize a command, or permit a native attempt.

That review completed with five findings: late-successful create cleanup bypass, behavioral/pre-aborted signal dispatch,
raw private error leakage, aliased authority domains, and locator-shaped connection identity. The candidate remains
rejected. See `CR12B_IDEA_110G_CONNECTOR_REVIEW_REMEDIATION.md` for the replacement and its new review gate.

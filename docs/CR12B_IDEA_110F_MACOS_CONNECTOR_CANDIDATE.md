# CR12B-IDEA-110F — macOS Hermes connector candidate

**Status:** Implemented locally as a provider-disabled candidate; independent security review is required before the
connector can be marked accepted or configured.

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

## Remaining gate

The implementation commit and review packet must be frozen, then a different independent reviewer must attack the exact
connector candidate. Producer tests cannot set `connectorImplementationAccepted`. Even an accepted report will not
configure the private port, enroll a signer or route, refresh the owner packet, authorize a command, or permit a native
attempt.

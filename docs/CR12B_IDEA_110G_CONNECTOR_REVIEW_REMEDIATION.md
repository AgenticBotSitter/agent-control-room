# CR12B-IDEA-110G — macOS connector review remediation

**Status:** Rejected after a different reviewer found that mutable native AbortSignal internals could still execute
caller behavior. Superseded by IDEA-110H; see `CR12B_IDEA_110H_OPAQUE_CANCELLATION_REMEDIATION.md`.

## Outcome

IDEA-110G preserves the complete negative IDEA-110F report and closes its two High and three Medium findings without
configuring a private port or contacting Hermes. The connector remains a provider-disabled protocol guard. The actual
Mac-private port still owns Hermes registration, local/SSH locators, keys, protected values, gateway endpoints, profile
paths, native session identifiers, and cleanup implementation.

## Finding closure

- `CR12B-110F-REV001-001`: `session.create` marks cleanup as required before private dispatch. Route close first aborts
  and joins the active request, then refuses to dispatch until a cleanup operation has been attempted. The fixed bridge
  can reconcile a create whose successful receipt was hidden by cancellation without retrying create.
- `CR12B-110F-REV001-002`: IDEA-110G attempted a host-intrinsic AbortSignal observer, but this closure was incomplete.
  A genuine signal could keep the expected outer descriptors while a built-in event map was replaced with a Proxy;
  listener installation executed that caller-owned trap. IDEA-110H replaces the native-signal component seam rather
  than attempting another mutable-internal shape check.
- `CR12B-110F-REV001-003`: private-port exceptions are discarded and replaced by a new bounded
  `IdeaLabErrorV1("integrity_failed")`. Private error identity, message, stack, cause, or attached values never cross the
  connector boundary.
- `CR12B-110F-REV001-004`: connection, route, permit, profile, conversation, returned lease, session, and epoch digests
  occupy distinct domains. Pairwise aliasing is rejected before acceptance and binding drift remains terminal.
- `CR12B-110F-REV001-005`: the fixed bridge domain-separates the signed enrollment's connection ID and sends only
  `connectionIdentityDigest` to the connector/private port. Raw host-, port-, SSH-, gateway-, or human-readable
  connection identifiers are absent from the connector contract.

## Lifecycle truth

The connector still permits one route-open attempt and no automatic retry. An uncertain open is attempt-bound close
only. Any create dispatch makes session cleanup mandatory; an uncertain operation enters cleanup-only state. A route
close cannot overtake an active call. Cleanup retains the fixed interrupt, status, close sequence, and the private route
close must still prove native session closure, lease release, disposable profile/workspace removal, and zero retained
native references.

The shipped disabled composition remains unchanged: zero configured ports, signers, routes, connection attempts, SSH
connections, native attempts, provider calls, live-panel eligibility, or execution authority.

## Verification

Focused connector, fixed-bridge, and readiness tests pass 27/27. The combined CR12B suite passes 153/153. TypeScript,
full lint, and stage zero pass. The complete lifecycle passes 769/769 pretests, 414/416 core tests with two intentional
platform skips, and 232/232 posttests. The production build and 3/3 rendered routes pass. All 32 migrations and 110
PostgreSQL tables verify, and whitespace validation passes.

No install, download, Hermes/SSH/provider/network contact, credential or protected-value access, native process,
Keychain operation, private-port configuration, enrollment, production database contact, deployment, hosting, DNS, or
other external effect occurred.

## Remaining gate

A fresh reviewer must review the exact IDEA-110H implementation and its replacement packet. The earlier IDEA-110G
packet SHA-256 `04a2c7859fce8646f83d9ec571d98cef633e646c0f2f4796f7aa33942f22d30b` remains historical evidence, not a current
acceptance packet. The next review must independently reproduce all five original attacks and exercise
late-success, late-throw, malformed receipt, abort-at-await, post-capture mutation, error-sentinel, pairwise digest/lease/
session alias, locator custody, default-disabled composition, and source/upgrade drift. Only an accepted immutable report
can remove `connector_implementation_unaccepted`; signer enrollment, signed route enrollment, effect-free preflight,
packet refresh, fresh owner authorization, and native qualification remain separate later gates.

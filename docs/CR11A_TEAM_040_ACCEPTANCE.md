# CR11A TEAM-040 acceptance

**Status:** Accepted for the exact repository-only, injected-fixture snapshot
**Date:** 2026-08-30
**Hermes pin:** package `0.20.6`, revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`

## Delivered

- A closed, read-only Hermes Bot Mode observation contract for profiles, rooms, routines, and safe-summary events.
- An exact compatibility manifest whose ordered read ceiling is frozen and whose write set is empty.
- Injected-only normalization into the existing digest-bound Project Agent Team workspace.
- Stable project/profile/device identity binding with device-disambiguated handles and digest-only evidence references.
- Explicit observed, absent, and unknown collection truth without invented agents or optimistic defaults.
- Evidence-backed presence that accepts `working` only from a current Control Room lease or authenticated heartbeat.
- Read-only routine projection and War Room normalization under the existing member, round, event, pair-message, duration, reasoning, and cost ceilings.
- Strict secret, full-message, raw-prompt, native-profile, provider-session, shared-provider, authority, accessor, Proxy, and digest-drift rejection.
- A frozen conformance harness that accepts only manifest, compatibility evaluation, and normalization operations.
- Sanitized fixtures plus hostile pin-drift, substitution, schema, scope, chronology, identity, resource, and authority tests.

## Acceptance assertions

- TEAM-040 cannot discover, connect to, launch, read, write, message, schedule, approve, dispatch, or execute against an installed Hermes runtime.
- The accepted source mode is exactly `injected_only`; `nativeQualified` is false.
- Compatibility requires the exact package, revision, contract, ordered reads, empty writes, and negative-authority declarations.
- A recent Bot Mode message or enabled profile cannot claim `working` without current canonical Control Room evidence and bound current work.
- Expired presence becomes stale, disabled profiles become offline, and absent or unknown profiles do not invent an Agent Team workspace.
- Identity is bound to tenant, workspace, project, profile-key digest, and device-key digest and is recomputed during projection parsing.
- Room membership, author, mentions, sequence, chronology, scope, and every frozen resource ceiling are enforced.
- Routine and room observations grant no schedule, command, provider, work, approval, lease, dispatch, or execution authority.
- Safe output contains only the existing Agent Team projection, collection truth, identity bindings, compatibility facts, and canonical digests.
- Conformance rejects extra adapter methods, mutable or cyclic manifests, hostile decisions, unsafe fixtures, substituted normalization, and compatibility drift.

## Verification

The dedicated adapter gate passes 12/12 and the combined CR11A gate passes 41/41. Registered pretest passes 562/562. The main suite reports 416 total with 414 passed, zero failed, and two intentional platform skips. Public post-test passes 52/52. Type checking, full lint, the production build, 2/2 rendered routes, migration verification through 0026/96 tables, macOS stage-zero readiness, and diff whitespace validation pass.

## Explicit non-events

No installed Hermes lookup, native profile read, Bot Mode command/API/RPC call, provider contact, full-message or prompt read, memory or credential access, shared provider use, message send, routine mutation, schedule creation, canonical work creation, owner decision, approval, attempt, lease, command, dispatch, execution, network request, DNS operation, Cloudflare action, hosting, deployment, installation, publication, or production effect occurred. Private GitHub branch and pull-request transfer may preserve this repository evidence but grants no runtime or integration authority.

## Deferred gate

CR11A-TEAM-050 is separate. It may record a disabled disposition without native contact, or it may perform one owner-authorized, one-profile/one-room sanitized read-only qualification under a new frozen packet. TEAM-040 does not authorize that attempt.

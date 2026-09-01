# CR13A-LIVE-030 protected enrollment intake acceptance

**Status:** implementation candidate; exact immutable product target and independent review remain pending
**Effect boundary:** repository code, PostgreSQL-compatible migration, and PGlite tests only; the runtime source is disabled
and no SSH, Hermes, provider, credential, production database, deployment, or network effect occurred

## Delivered boundary

- Migration `0035_cr13a_connection_enrollment_intake.sql` adds a tenant-scoped append-only receipt chain and
  authenticated stream head. Each accepted delivery is bound to its enrollment, canonical connection and node,
  active-key digest, registry revision, complete signed-envelope digest, and safe receipt.
- `ConnectionEnrollmentIntakeServiceV1` reads only through a server-held source capability. The source's label is not
  authentication evidence. Inside one locked database transaction, Control Room independently resolves the current
  active node key and verifies the signed Hermes 0.21 enrollment before writing anything.
- Registry enrollment and intake evidence commit atomically. If registry persistence, audit insertion, or head update
  fails, the entire operation rolls back. Exact replay returns the original verified receipt without another write;
  changed delivery/enrollment replay fails closed.
- The complete bounded audit stream and authenticated head are verified before replay or append. Mutation, deletion, wrong
  integrity keys, cross-scope keys, expired envelopes, untrusted signatures, behavioral values, and malformed database
  rows fail with bounded safe codes.
- The returned receipt contains opaque digests, an intake reference, registry revision, and negative authority only.
  Tenant, connection, enrollment, node, key, route, profile, host-key, public-key, and signature values remain in the
  protected server/database boundary.
- The local pilot constructs the service with `DisabledConnectionEnrollmentDeliverySourceV1`. No app runtime port,
  browser route, POST endpoint, connector, SSH channel, or native Hermes process can reach this intake in this block.

## Security invariants

1. Protected delivery and cryptographic trust are separate. A source can supply bytes and timing; only verification of
   the exact enrollment signature against the active database key establishes acceptance.
2. Tenant, node, connection, and key identity are derived from the verified envelope and database relationship, never
   from browser headers or public request parameters.
3. One outer database transaction owns registry revision and audit evidence. There is no accepted registry row without
   its intake receipt, and no accepted receipt without its referenced registry row.
4. Exact replay is inert and remains available after later key retirement/revocation; revocation still rejects every new
   enrollment. Reuse of either a delivery ID or enrollment ID with different protected material is rejected.
5. Intake grants no approval, command, network, lease, execution, qualification, live-panel, provider, or deployment
   authority. Enrollment and telemetry freshness remain independent.
6. PGlite remains local-development/test storage only. Production remains one private PostgreSQL primary and is not
   contacted or configured here.

## Verification recorded

- TypeScript and full lint pass.
- Focused Connection Center/intake verification passes 21/21; combined CR13A passes 37/37.
- The complete npm lifecycle passes: 769/769 pretests, 418/420 core tests with two intentional platform skips, and
  272/272 posttests.
- Migrations `0001` through `0035` apply and verify 117 PostgreSQL tables.
- macOS stage zero reports `ready_for_runtime_check`; no runtime/native command was run.
- Production build, 4/4 rendered routes, and `git diff --check` pass.

Focused hostile coverage includes:

- valid active-key signature, exact replay before and after key revocation, new-intake rejection after revocation, and
  changed replay;
- concurrent independent enrollment serialization;
- untrusted key, cross-scope node, expired envelope, unavailable source, and behavioral input rejection;
- forced audit-write failure with complete registry rollback and successful clean retry;
- wrong audit key, behavioral database rows, record mutation, and record deletion;
- absence of browser or HTTP enrollment mutation paths and a disabled local runtime source.

## Remaining gate

Freeze an exact product commit, bind a security/integrity review packet to that commit, and obtain a different
independent review before integration. Review acceptance will authorize only repository integration. It will not enable
a live delivery source, enroll a machine, contact Hermes, open SSH, use credentials, call a provider, attach production
PostgreSQL, deploy, host, or grant execution authority.

After acceptance and integration, CR13A-LIVE-040 may define the authenticated node-protocol delivery adapter that feeds
this protected source. That adapter must preserve the envelope's independent active-key verification and remain disabled
until separately reviewed. Use `gpt-5.6-sol` with `high` reasoning for the integration/review gate; use `xhigh` if the
next implementation changes the signed node protocol or live ingress trust boundary.

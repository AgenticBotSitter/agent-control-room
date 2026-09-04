# CR13A-LIVE-470 — Production Capsule and Owner-Native Authorization Design

**Status:** accepted for architecture-only integration after remediation and different independent 0/0/0 re-review

**Accepted LIVE-450 architecture:** `8413ad8acca4dbd79ffd56b666ad3c0a25351a36`

**Accepted LIVE-450 design SHA-256:**
`f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e`

**Accepted LIVE-450 review SHA-256:**
`f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1`

**Accepted LIVE-460 product:** `2cab7dff3a2ca277f4b4d766a2cd02779e0f505d`

**Accepted LIVE-460 tree:** `676cc414327a2acf714b96a149aea43348d48049`

**Accepted LIVE-460 review SHA-256:**
`9514b65db763819683e05584e162dad996b662fcdb0a48e6c80d98e44795252f`

**Accepted LIVE-440 architecture:** `711d4fc67f9e27f52553fd63152188203b173a9d`

**Accepted LIVE-440 tree:** `b5186bb238baf37fc23a9443824ed9b8c05f0124`

**Accepted LIVE-440 design SHA-256:**
`8c01036039e2a1a819968960fd87e2a0a3e4c960a70a905ec4d769e9b8b117ff`

**Accepted LIVE-440 review SHA-256:**
`e53ec53383720fe5e58d6cff5d23a572620226ac07585f090507fb2c06c3c518`

**Required model / effort:** `gpt-5.6-sol` / `xhigh`

**Effect boundary:** repository documentation only; no capsule or authorization implementation, migration, key,
credential, database, high-water, source/provider import or call, host read, process, listener, network, runtime wiring,
deployment, DNS, hosting, or production effect

## Purpose

LIVE-460 makes the complete attestation vocabulary machine-checkable but implements no protected behavior. LIVE-470
freezes two boundaries that must fit together before any protected implementation begins:

1. the non-exporting production construction capsule that alone may resolve the accepted database, keys, source,
   privacy transform, five providers, signer, high-water adapter, verifier, and cleanup observer; and
2. the separate authenticated owner-native authorization and durable exact-product attempt ledger that the capsule
   must consume before the source or any protected provider can run.

This design does not implement either boundary. It creates no authorization, product-attempt row, capsule, handle,
provider result, source call, or runtime consumer.

## Fixed private module topology and exact call graph

The future child-process production root is the accepted LIVE-440 source-owning module itself:
`src/connection-registry/v1/private-loopback-unreachable-atomic-native-observation-source.ts`. The production capsule
is a private lexical graph constructed inside `runPrivateAtomicSourceLookupCompositionV1`; it is not a separate module,
object passed to the runner, registry, callback, or exported capability. The accepted LIVE-440 commit/tree/design/
review identities above are direct manifest and owner-body bindings, not merely transitive LIVE-450 references.

One later accepted disposable-attestor child entrypoint may directly import the source-owning module and call one
frozen runner. Both modules are absent from every barrel. No application route, API, UI, worker, scheduler, Idea Lab,
Hermes, MCP, plugin, ordinary startup, or test may import either production path.

The child runner signature accepts only two exact already sealed plain-data envelopes: owner-native authorization and
broker invocation authorization. It accepts no private context, database, key, source, provider, signer, verifier,
checkpoint, clock, nonce, callback, callable, configuration, path, command, environment value, generic dependency, or
arbitrary options. It returns one private signed attestation-settlement frame to its parent harness and no raw value.

Inside one unbroken source-owning-module lexical flow, the runner resolves the capsule, materializes context, consumes
both authorizations in order, retrieves and invokes its own private source, validates raw state, performs synchronous
protected intake, clears source/raw/privacy references before the first post-source `await`, and only then calls the
five private provider stages. Neither the parent, child entrypoint, capsule components, nor a separate module can
receive the source, private map/key, raw record, intake function, or private context. The source-owning runner obtains
and retains its capsule-minted context only through local lexicals; there is no context-transfer function signature.

Exact future call graph:

1. owner-attended parent qualification harness authenticates the launch packet and creates one disposable child;
2. parent writes one bounded authenticated canonical launch frame containing only both sealed envelopes;
3. child entrypoint parses the frame and calls
   `runPrivateAtomicSourceLookupCompositionV1(ownerEnvelope, invocationEnvelope)` exactly once;
4. that same source-owning function executes LIVE-450 stages 1-31 and emits at most one platform-signed private
   settlement frame through the child entrypoint;
5. child exits and can perform no later stage;
6. parent authenticates the frame and exit, then a separately accepted cleanup observer runs stages 32-34;
7. a parent-side narrowly scoped finalizer performs stage 35 from exact durable facts; and
8. a different report-only reviewer performs stage 36. Candidate assembly still requires that review evidence.

The capsule never receives or returns source/raw state. The parent receives only an authenticated private envelope,
never the raw observation, provider result, key, or child callable.

The normative future signatures are exact; the named records are frozen, deeply read-only plain-data shapes with no
index signature, optional field, callable, accessor, symbol, prototype extension, transfer handle, or generic type:

```ts
runOwnerAttendedPrivateAttestationHarnessV1(
  launch: ExactOwnerAttendedLaunchPacketV1,
): Promise<ExactPublicTerminalProjectionV1>;

runDisposablePrivateAttestorChildEntrypointV1(): Promise<never>;

runPrivateAtomicSourceLookupCompositionV1(
  ownerEnvelope: SealedOwnerNativeAuthorizationEnvelopeV1,
  invocationEnvelope: SealedBrokerInvocationAuthorizationEnvelopeV1,
): Promise<PrivateStage31SettlementV1>;

observeReservedAfterExitCleanupV1(
  reservation: CapsuleMintedCleanupReservationV1,
  exit: AuthenticatedDisposableChildExitV1,
): Promise<PrivateCleanupSettlementV1>;

finalizePrivateAttestationV1(
  stage31: AuthenticatedPrivateStage31SettlementV1,
  cleanup: AuthenticatedPrivateCleanupSettlementV1,
): Promise<PrivateFinalDispositionV1>;
```

Only the parent harness is an owner-facing entry. The child entrypoint is the sole direct consumer of the source-owning
runner. Cleanup/finalizer parameters can be minted only by their immediately preceding fixed stage and are never
deserialized from caller input. `PrivateStage31SettlementV1` contains transformed/digested claims only, never source
or provider raw values. The child entrypoint resolves its fixed launch/settlement IPC keys after authorized entry,
authenticates exactly one launch frame, passes only the two parsed envelopes to the runner, wraps its returned stage-31
body in exactly one settlement frame, clears references, and exits.

## Dormant construction versus production resolution

Repository implementation may first add inert contracts and dormant constructors whose status reports zero use. A
constructor does not contact a database, key store, provider, source, or host until the separately accepted production
entry is called. Ordinary tests cannot import the production root or register components into it.

The real source-owning root may become callable only after one exact signed deployment manifest proves every component below is an
independently accepted immutable product and all protected custody is available. Missing, substituted, duplicated,
revoked, expired, wrong-scope, behaviorally supplied, or unreviewed components stop before owner spend.

## Exact capsule manifest, trust bootstrap, and activation

The accepted deployment product pins one owner-root public-key algorithm, key ID, revision, and SHA-256 fingerprint
out of band. Neither PostgreSQL, the runtime environment, a deployment manifest, nor the protected trust registry may
replace that pin. The private root key is offline and cannot sign runtime records. It signs only a trust-registry
genesis, a trust-registry revision, or a dual-signed root-rotation statement accepted by a separately reviewed
deployment product.

The protected trust registry is a strict canonical signed chain. Each revision contains exactly: schema version,
registry ID, monotonically increasing `registry_sequence`, `prior_registry_digest` (all-zero only at genesis), policy
revision, product-catalog revision, and an ordered key array. Every key entry contains role, key ID, algorithm,
fingerprint, revision, status (`pending`, `active`, `verification_only`, `revoked`, or `destroyed`), inclusive
`not_before`, exclusive `expires_at`, and nullable `revoked_at`. The owner-root signature covers the canonical body
digest and prior link. Entries are unique by role plus revision; an active revision cannot go backward or overlap
another active revision for the same role except during a declared bounded rotation overlap.

One canonical immutable deployment manifest binds:

- LIVE-450 architecture and LIVE-460 contract product/tree/review identities;
- source-owner and dormant runner product/tree/review identities;
- capsule lexical-graph, child entrypoint, owner-attended parent harness, cleanup/finalizer, and public-projector
  product/tree/review identities;
- the owner authorization contract/store, broker invocation contract/store, and context reservation product/tree/
  review identities;
- the five provider product/tree/review identities in LIVE-460 order;
- privacy transform, platform signer, PostgreSQL pending/final writers, high-water adapter, private verifier, cleanup
  observer, and cleanup signer product/tree/review identities;
- tenant, project, connection, node, target platform/runtime, deployment, and policy identities;
- manifest sequence, prior-manifest digest, signed product-catalog revision, exact trust-registry sequence/digest, and
  expected trust-registry and deployment-manifest high-water revisions/head digests;
- every protected key ID/fingerprint/revision, purpose, expiry, and revocation-catalog revision; and
- the exact allowed effect classes and zero ceilings for every prohibited effect.

The manifest body also binds the accepted LIVE-440 commit, tree, design SHA-256, and review SHA-256 shown above. The
owner authorization repeats those four values. No transitive LIVE-450 reference can substitute for either direct
binding.

The manifest is signed by a deployment-manifest key that is distinct from owner authorization, invocation
authorization, authorization-state, product-attempt-state, privacy, five provider, platform-signature, PostgreSQL
writer, high-water, cleanup, TLS, node-channel, and artifact keys. A public digest can identify the accepted manifest
but cannot authenticate or activate it.

The trust registry and deployment manifest each use an independent non-authoritative protected anchor with a distinct
writer key and custody boundary. Each anchor stores only stream ID, monotonic revision, authenticated head digest,
last request ID digest, and authentication tag. The trust anchor cannot adopt a manifest; the manifest anchor cannot
change trust; neither stores business state. PostgreSQL remains the sole global write authority.

Each registry or manifest revision moves through `pending_anchor`, `adopted`, or `revoked`. Its narrowly scoped
PostgreSQL writer appends a pending record containing expected and desired heads plus one immutable idempotent CAS
request ID; its distinct anchor writer performs that one CAS; its finalizer may append `adopted` only after exact
receipt and state verification. An old valid signature is rejected after the authenticated anchor advances. Rotation
requires old-and-new signatures during a bounded overlap; compromise skips overlap, revokes the affected key, and
quarantines every dependent product until a new owner-root-approved revision is adopted. Owner-root rotation itself
requires an out-of-band newly pinned deployment product and a statement signed by both roots unless compromise makes
the old root unavailable, in which case no automatic rotation is allowed.

Split-commit recovery is closed: pending plus old anchor reissues only the identical CAS request; pending plus exact
desired anchor finalizes the predetermined adoption; adopted plus matching anchor reads; database old plus anchor
ahead, database ahead plus anchor old/different, missing record, fork, or unknown CAS quarantines. Recovery never
reconstructs, signs, substitutes, rolls back, or activates a revision.

No manifest, trust registry, key, database, anchor, source, provider, environment, host, or clock read occurs during
module import or capsule construction. Resolution begins only after the authorized child entry invokes the accepted
source-owning runner. The exact current manifest must match both authenticated current anchors before owner spend.

## Capsule resolution order

All resolution occurs before either owner or invocation authorization is spent:

1. parse both sealed envelopes as inert exact data without trusting their claims;
2. load and authenticate the one exact deployment manifest;
3. establish the private PostgreSQL session under the context writer's identity;
4. authenticate and read the owner and invocation authorization stores without consuming either;
5. resolve the one-use privacy transform/key operation;
6. resolve the platform signer and separately the cleanup signer/observer;
7. resolve the five provider operations in LIVE-460 order;
8. resolve PostgreSQL pending/final writer identities, high-water adapter, and private verifier;
9. preflight every component's product, key state, exact scope, use ceiling, and readiness without reading a protected
   source/provider value or producing a signature;
10. materialize the cleanup reservation from the authorization's immutable cleanup-reservation-intent digest;
11. materialize the private context reservation from its immutable intent digest, including trusted database time,
    provisional acceptance reference, ledger head, and expected high-water state; and
12. only then enter the atomic owner-native authorization/product-attempt consumption boundary.

Resolution produces one private capsule-held graph. Every node is exact and single-purpose. A component cannot return
a generic operation, object registry, callback, retry handle, alternate provider, or caller-selected bytes. Failure
releases all unspent reservations, terminally closes uncertain reservations, and never falls back.

## Owner-native authorization body

The future owner authorization uses one strict canonical body with these exact fields:

- body schema version; the outer envelope separately binds envelope/codec/signature versions and algorithms plus the
  canonical owner-body digest;
- LIVE-440 commit/tree/design/review, LIVE-450 architecture/design/review, and LIVE-460 product/tree/review identities;
- source-owner, runner, capsule, harness, owner-store, invocation-store, context, privacy, five providers, platform
  signer, PostgreSQL writers, high-water, verifier, cleanup observer, and cleanup signer product/tree/review identities;
- tenant, project, connection, node, target platform family, target runtime family, deployment, policy, operation,
  inert `candidate_proposal_id`, and exact `attempt_id`;
- deployment manifest ID/digest/sequence; trust-registry ID/digest/sequence; the expected manifest and trust-registry
  anchor revisions/head digests; protected product-catalog revision; and owner policy revision;
- owner authorization ID, owner-present issuer product/tree/review, strong-factor policy/evidence-class revision,
  fresh owner nonce digest, issued time, inclusive not-before time, exclusive expiry time, and cleanup deadline;
- broker invocation authorization ID, nonce digest, canonical body digest, registration identity digest, sealing-key
  revision, inclusive not-before/exclusive expiry, and exact tenant/project/connection/node/operation scope;
- immutable context-reservation-intent digest and cleanup-reservation-intent digest, cleanup subject/resource-set
  digest, and the six required cleanup fact names in LIVE-460 order; no actual reservation exists at issuance;
- protected subject-scope digest for each of the five providers in fixed LIVE-460 order;
- canonical private PostgreSQL destination identity digest, owner-attempt-anchor destination identity digest,
  attestation-anchor destination identity digest, and cleanup-anchor destination identity digest;
- key IDs/fingerprints/revisions for owner sealing, owner state, product-attempt state, privacy, five providers,
  platform signing, launch IPC, settlement IPC, high-water, and cleanup signing;
- exact owner window and context/child/cleanup/finalization relationships defined below;
- exact allowed effects: private PostgreSQL transactions, protected high-water read/CAS, the eight-value local source
  read, five bounded local supplementary reads, one fixed disposable-child creation, one bounded input frame, one
  bounded output frame, one platform signature, child exit/termination, and one after-exit cleanup
  observation/signature; and
- exact prohibited effects: listener/inbound/server socket or undeclared outbound socket, public endpoint or non-
  private network, model/provider call, arbitrary command/shell, SSH, MCP, plugin, application/runtime activation,
  candidate assembly, physical listener attempt, deployment, DNS, hosting, credential export, arbitrary file read,
  and every undeclared effect.

Canonical parsing rejects missing, extra, duplicate, reordered, aliased, non-normalized, accessor, proxy, symbol,
inherited, unsupported-version, unsupported-algorithm, or wrong-type fields without executing supplied behavior.
The body contains digests and public product identities only—never raw owner identity, nonce, key, credential, locator,
host value, path, PID, endpoint, command, provider content, or diagnostic.

The owner envelope permits only these logical-operation ceilings; every omitted operation and effect has ceiling zero:

| Logical operation | Exact maximum |
| --- | ---: |
| registration append plus nonce reservation transaction | 1 |
| registration-anchor CAS request/finalization | 1 / 1 |
| trust-registry / manifest authenticated reads | 4 / 4 |
| trust-anchor / manifest-anchor state reads | 4 / 4 |
| owner-store authenticated read transactions / owner-attempt-anchor reads | 5 / 4 |
| trusted PostgreSQL time reads across registration, reserve, spend, rechecks, cleanup, finalization | 7 |
| context reservation PostgreSQL append / head advance / terminal tombstone | 1 / 1 / at most 1 |
| cleanup reservation PostgreSQL append / head advance / terminal tombstone | 1 / 1 / at most 1 |
| owner consumption plus product-attempt PostgreSQL transaction | 1 |
| owner-attempt-anchor CAS request/finalization | 1 / 1 |
| broker authorization PostgreSQL consumption / head advance / recheck | 1 / 1 / 1 |
| source lookup / source invocation | 1 / 1 |
| each of five provider reservations / invocations | 1 / 1 each |
| privacy transform / platform sign / private verify | 1 / 1 / 1 |
| attestation PostgreSQL pending append / head advance / anchor reads / anchor CAS / finalization | 1 / 1 / 4 / 1 / 1 |
| child creation / launch IPC input / settlement IPC output / child termination | 1 / 1 / 1 / 1 |
| cleanup observation / cleanup sign / PostgreSQL pending append / head advance / anchor reads / anchor CAS / finalization | 1 / 1 / 1 / 1 / 3 / 1 / 1 |
| final acceptance append / public projection / independent review submission | 1 each |
| read-only recovery query for any uncertain request | 1 per immutable request ID; no new effect |

The owner window is at most 300 seconds. A materialized private context is at most 60 seconds and must expire before
the owner window. The one child attempt, all stages 1-31, and its exit fit inside both windows. Cleanup starts only
after authenticated child exit, completes within 120 seconds of exit, and never later than 600 seconds after owner
issuance. Stage 35 completes within 30 seconds of accepted cleanup; stage 36 is report-only and grants no extension.
Expiry never authorizes a retry. Reservation intent is not a reservation, capability, handle, or object; failed or
uncertain materialization creates a terminal tombstone and returns nothing usable to the caller.

## Authentication and key separation

Every protected role matches exactly one active manifest entry and one active trust-registry entry. Symmetric values
are 32-byte purpose-bound values; public/private roles bind algorithms and public fingerprints. All key material,
including different revisions, is pairwise byte-distinct. A public key is never treated as a secret, but its encoded
bytes still cannot equal any other role's encoded key bytes.

| Role | Permitted use only |
| --- | --- |
| out-of-band owner root | verify trust-registry and root-rotation statements |
| trust-registry signer / trust-anchor writer | sign one registry revision / CAS one registry head |
| deployment-manifest signer / manifest-anchor writer | sign one manifest / CAS one manifest head |
| owner authorization sealing / owner state | authenticate one owner body / registration, nonce, consumption streams |
| product-attempt state / owner-attempt-anchor writer | authenticate product-attempt rows / CAS the composite owner head |
| broker invocation sealing / state / consumption | authenticate broker body / registration state / one spend |
| privacy transform | transform only the eight source fields and five provider domains |
| five provider roles | authenticate exactly one ordered provider result each |
| platform signer | sign one complete private attestation envelope |
| launch IPC / settlement IPC | authenticate one parent-to-child frame / one child-to-parent frame |
| attestation DB state / attestation-anchor writer | authenticate attestation rows / CAS attestation head |
| cleanup signer / cleanup DB state / cleanup-anchor writer | sign cleanup result / authenticate rows / CAS cleanup head |
| TLS / node channel | authenticate their one private transport purpose; never business state |

Activation requires `active` status, matching product/purpose/scope, and current time. Rotation first adopts a new
trust-registry revision, permits a bounded explicit overlap only for verification, advances every dependent manifest,
and then moves the old key to `verification_only` or `revoked`. Historical public verification keys are retained.
Historical symmetric authentication values remain behind a fixed verification-only interface that accepts only an
existing record and can never authenticate a new write. Each stream begins a new key epoch cross-linked to the final
digest and revision of the prior epoch. No old key signs or authenticates a new record.

Revocation stops new writes immediately. Suspected compromise quarantines the key, every dependent manifest, and any
unsettled attempt; it never falls back. Destruction is permitted only after a separately accepted archive-retention
product proves the corresponding authenticated history is no longer required for qualification. Unknown key state is
terminal. No module generates, persists, returns, logs, includes in public evidence, or exports production key bytes.

## PostgreSQL authority, exact schema, and writer ceilings

PostgreSQL remains the sole global write authority. The future owner store uses append-only authenticated streams for:

- sealed owner authorization registration plus one tenant-scoped nonce reservation;
- owner authorization consumption;
- exact source-owner/runner product-pair attempts; and
- authenticated stream heads for each class.

The following is the complete owner-store schema. `digest32` means `bytea NOT NULL CHECK (octet_length(value)=32)`;
`id_text` means normalized `text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 160)`; every time is
`timestamptz NOT NULL`; every sequence is `bigint NOT NULL CHECK (value > 0)`. Private canonical bodies are stored as
`jsonb` and are never returned by public roles. Product and tree IDs are lowercase hexadecimal `text` with length 40.

| Table | Exact columns beyond `tenant_id id_text`, `schema_version smallint NOT NULL CHECK (=1)` |
| --- | --- |
| `owner_store_heads` | `stream_name text CHECK IN ('registration','nonce','consumption','product_attempt')`, `head_sequence bigint CHECK (>=0)`, `head_digest digest32`, `key_id id_text`, `key_revision bigint CHECK (>0)`, `updated_at timestamptz`; PK `(tenant_id,stream_name)` |
| `owner_authorization_registrations` | `sequence bigint`, `authorization_id_digest digest32`, `envelope_digest digest32`, `body jsonb NOT NULL CHECK (jsonb_typeof(body)='object')`, `body_digest digest32`, `nonce_digest digest32`, `manifest_digest digest32`, `context_intent_digest digest32`, `cleanup_intent_digest digest32`, `issued_at/not_before/expires_at timestamptz`, `prior_digest/record_digest/auth_tag digest32`, `key_id id_text`, `key_revision bigint`, `created_at timestamptz`; PK `(tenant_id,sequence)`, UNIQUE `(tenant_id,authorization_id_digest)`, CHECK `issued_at<=not_before AND not_before<expires_at` |
| `owner_authorization_nonces` | `sequence bigint`, `nonce_digest digest32`, `authorization_id_digest digest32`, `registration_sequence bigint`, `prior_digest/record_digest/auth_tag digest32`, `key_id id_text`, `key_revision bigint`, `created_at timestamptz`; PK `(tenant_id,sequence)`, UNIQUE `(tenant_id,nonce_digest)`, FK `(tenant_id,registration_sequence)` to registrations |
| `owner_authorization_consumptions` | `sequence bigint`, `authorization_id_digest/nonce_digest/body_digest digest32`, `registration_sequence bigint`, `nonce_sequence bigint`, `attempt_id_digest/context_reservation_digest/cleanup_reservation_digest/manifest_digest digest32`, `consumed_at timestamptz`, `prior_digest/record_digest/auth_tag digest32`, `key_id id_text`, `key_revision bigint`; PK `(tenant_id,sequence)`, UNIQUE `(tenant_id,authorization_id_digest)`, FKs `(tenant_id,registration_sequence)` and `(tenant_id,nonce_sequence)` to exact registration and nonce |
| `owner_product_attempts` | `sequence bigint`, `node_id id_text`, `source_owner_commit/source_owner_tree/runner_commit/runner_tree text CHECK length=40`, `authorization_id_digest/consumption_record_digest/attempt_id_digest/candidate_proposal_digest/context_reservation_digest/cleanup_reservation_digest/manifest_digest digest32`, `closed_at timestamptz`, `prior_digest/record_digest/auth_tag digest32`, `key_id id_text`, `key_revision bigint`; PK `(tenant_id,sequence)`, UNIQUE `(tenant_id,node_id,source_owner_commit,source_owner_tree,runner_commit,runner_tree)`, UNIQUE `(tenant_id,consumption_record_digest)` |
| `owner_anchor_requests` | `request_id_digest digest32`, `phase text CHECK IN ('registration','consumption_product')`, `authorization_id_digest digest32`, `expected_anchor_revision bigint CHECK (>=0)`, `expected_anchor_head digest32`, `desired_anchor_revision bigint CHECK (=expected_anchor_revision+1)`, `desired_composite_head digest32`, the four `desired_*_sequence bigint CHECK (>=0)` and four `desired_*_head digest32`, `created_at/deadline_at timestamptz`, `request_auth_tag digest32`; PK `(tenant_id,request_id_digest)`, UNIQUE `(tenant_id,phase,authorization_id_digest)` |
| `owner_anchor_settlements` | `request_id_digest digest32`, `settlement text CHECK IN ('anchored','terminal_ambiguous','quarantined')`, `observed_anchor_revision bigint CHECK (>=0)`, `observed_anchor_head digest32`, `receipt_digest digest32`, `settled_at timestamptz`, `settlement_auth_tag digest32`; PK `(tenant_id,request_id_digest)`, FK to exact request, CHECK that `anchored` matches that request's desired revision/head |

Every digest field has the `digest32` constraint, every named revision has `bigint NOT NULL CHECK (>0)`, and all FKs
are `ON UPDATE RESTRICT ON DELETE RESTRICT`. The four stream heads start at sequence zero with a domain-separated
genesis digest. Canonical product normalization rejects uppercase, abbreviated, non-hex, or symbolic Git identities.
Record authentication covers table domain, every column except `auth_tag`, prior head, and schema version.
The authorization body is first parsed from duplicate-detecting UTF-8 canonical JSON, then stored only as semantic
`jsonb`; the exact canonical bytes are not retained. Every read deterministically re-encodes the fixed field set,
recomputes its SHA-256 digest, and verifies that digest plus the envelope/record tags before use. JSONB operators are
not exposed to writer callers, and no query may select a subset and treat it as an authorization.

Only security-definer procedures with fixed `search_path`, explicit role checks, serializable isolation, expected
sequence/head parameters, and exact typed arguments can append rows or advance heads. Base tables revoke all from
`PUBLIC`; application, migration, owner issuer, capsule, provider, and public-reader roles receive no direct DML.
Append-only triggers reject `UPDATE`, `DELETE`, and `TRUNCATE`, including by writer roles. Schema ownership belongs to
a non-login migration owner. No procedure executes dynamic SQL or accepts JSON for control fields.

Database constraints enforce unique tenant/authorization ID, tenant/nonce, and tenant/node/source-owner-product/
runner-product identities. The product-pair constraint deliberately excludes candidate proposal, attempt, and
authorization IDs so relabeling cannot create a second attempt for the same product pair.

Writer identities are non-overlapping:

- `owner_registration_closure_writer` can execute only one procedure that atomically appends registration, nonce,
  both heads, and the matching registration anchor request;
- `owner_consumption_product_closure_writer` can execute only one procedure that atomically appends consumption,
  product attempt, both heads, and the matching consumption/product anchor request;
- distinct owner-state and product-attempt tagger roles own fixed internal authentication functions for their one row
  domain; only the two closure procedures may execute them, and the tagger roles have no table DML or caller-facing
  procedure grant;
- `owner_anchor_cas_writer` can submit only a byte-identical stored request to the external owner-attempt anchor and
  has no PostgreSQL write grant;
- `owner_anchor_settlement_writer` can execute only the exact receipt-verifying settlement procedure; and
- `owner_authorization_reconciliation_reader` has `SELECT` only on one security-barrier terminal-truth view.

No public/capsule role can invoke an individual row or head append. The two closure procedures acquire all four head
rows in fixed lexical order, recompute both record tags through their purpose-specific internal taggers, enforce
expected sequence/head predicates, insert every coupled row, and either commit all effects or none. The database
transaction role cannot sign or CAS an independent anchor; the anchor writer cannot alter PostgreSQL.

No writer may update/delete/truncate rows, grant itself another role, create schema, issue an authorization, call a
source/provider, or write the context, attestation, high-water, or cleanup ledgers. Migrations deny update, delete, and
truncate and preserve one authenticated append-only history.

The owner-attempt anchor is independently protected and non-authoritative. Its authenticated composite head includes
the exact revision, sequence, and digest of all four owner-store heads. It cannot store an authorization, nonce,
consumption, product attempt, owner identity, body, or business state. Whole-PostgreSQL rollback is detected because an
older set of all four heads cannot match the monotonically advanced independent composite anchor.

## Registration, anchoring, and uncertainty

Registration and nonce reservation occur in one PostgreSQL transaction that appends both exact rows, advances both
heads, and appends the one `registration` anchor request naming the resulting four-head composite. It never grants
native authority. The owner-attempt-anchor writer performs only that request's same idempotent CAS; the settlement
writer appends `anchored` only after exact receipt/state comparison. Only an anchored registration is eligible for
capsule entry. An exact replay returns its inert status; any changed authorization ID, nonce, body, scope, product,
key revision, time, intent, or anchor request is a conflict.

If PostgreSQL or CAS return is uncertain, no capsule entry proceeds. Recovery uses the exact matrix below and never
creates a new request. Even an exact late `anchored` result remains unspent and must re-enter through normal current
validation with its original envelope; expiry or any changed manifest/key/policy rejects it.

## Owner authorization state machine

The owner authorization boundary has these exact states:

1. `registration_pending_anchor` — registration, nonce, both heads, and immutable anchor request committed, but no
   matching anchor settlement is yet proved;
2. `registered_unspent` — exact desired composite anchor and `anchored` settlement are proved;
3. `preflight_validated_unspent` — a read-only exact validation confirms registration, trusted database time, manifest,
   product pair unused, capsule/provider/cleanup readiness, and reserved context identity; every readiness record is a
   capsule-minted exact object bound to both authorization body digests, manifest, context, cleanup scope, and attempt;
4. `consumption_product_pending_anchor` — the atomic consumption/product rows, both heads, and same immutable anchor
   request committed; the product pair is already closed and native work cannot begin;
5. `consumed_product_attempt_closed` — the exact desired composite anchor and final settlement are synchronously
   proved on the original uninterrupted path;
6. `already_consumed_terminal` — exact replay or product-pair reuse returns terminal non-authority;
7. `rejected_before_consumption` — a proven no-commit failure returns no spend and permits only a newly evaluated
   authorization after the context reservation is terminally closed; and
8. `terminal_consumption_or_product_attempt_ambiguous` — a consumption transaction, CAS, settlement, or verification
   result cannot be proved synchronously and all later native stages stop forever for that product pair.

Registration is not owner execution approval by itself. Validation is not spend. A receipt is not a capability. Only
the exact fresh in-memory object identity returned by successful atomic consumption may flow privately to the next
capsule stage; it is never accepted from a caller or returned publicly.

## Atomic consumption and exact-product closure

One transaction, under trusted database time and serializable/row-locking semantics, must:

1. verify the complete registration/nonce/consumption/product-attempt streams and authenticated heads;
2. verify the exact sealed body, capsule manifest, protected key revisions, tenant/project/connection/node scope,
   inert candidate proposal, attempt, operation, and inclusive-not-before/exclusive-expiry window;
3. verify the pre-reserved context and cleanup reservation identities without consuming or rewriting them;
4. prove no row exists for the exact tenant/node/source-owner-product/runner-product pair;
5. append one owner-consumption row;
6. append one exact-product-attempt row bound to that consumption and both reservations; and
7. advance both authenticated heads atomically; and
8. append the one immutable `consumption_product` owner-anchor request whose desired composite includes the exact
   registration, nonce, consumption, and product-attempt heads.

The owner authorization and product pair succeed or fail together. There is no state in which owner consumption is
committed but the product-pair attempt remains reusable. Database engines or deployments unable to guarantee that
atomicity cannot qualify.

The capsule next submits only that same request ID/body to the owner-attempt anchor. A known successful CAS is followed
by one settlement append and a fresh read that verifies the rows, all four heads, composite anchor, receipt, body,
manifest/trust/catalog/key revisions, trusted database time, context lifetime, and cleanup deadline. Only the original
uninterrupted path that receives all those exact known results obtains the fresh private receipt and may spend the
separate broker invocation authorization. Any failure or uncertainty is terminal with the product pair closed.

## Failure, uncertainty, and reconciliation

Known rejection before the atomic transaction maps to `rejected_before_spend`, closes/tombstones the context
reservation, and permits only a new separately evaluated owner authorization. The same owner authorization, nonce,
context, attempt, or cleanup reservation is never retried or reused.

Known rollback before any consumption transaction commit maps to `rejected_before_spend`; reconciliation must prove the absence
of both consumption and product-attempt rows and unchanged heads. If absence cannot be proved, the result is terminal
ambiguous. A returned transaction error alone is not proof of rollback.

Commit-return uncertainty, connection loss at commit, CAS-return uncertainty, head mismatch, partial row visibility,
unexpected product-pair row, missing corresponding consumption, deletion, reordering, authentication failure, time
rollback, or writer uncertainty maps to `terminal_owner_authorization_spent_or_uncertain`. The capsule releases
handles and stops before broker spend, source lookup, source call, and providers.

Recovery compares one exact PostgreSQL request/row/head set with the independently protected owner-attempt anchor:

| PostgreSQL fact | Owner-attempt anchor fact | Fixed result |
| --- | --- | --- |
| no exact registration rows/request; all four heads exact old | exact old | proven no registration; a newly issued authorization may start |
| exact registration pending/request; heads exact desired | exact old | reissue only the same registration CAS request; no capsule entry yet |
| exact registration pending/request; heads exact desired | exact desired with matching receipt | append/read exact anchored settlement; registration remains unspent |
| database old or missing exact request/rows | anchor ahead | quarantine whole-database rollback/deletion; no reconstruction |
| database heads ahead, forked, or request mismatched | anchor old or different | quarantine database fork/tamper |
| exact consumption/product rows/request; all four heads exact desired | exact old and CAS was never invoked | recovery may submit only the same CAS to close evidence; product never resumes |
| exact consumption/product rows/request; all four heads exact desired | exact desired with matching receipt | finalize/read terminal closed state; product never resumes after any uncertainty |
| no exact consumption/product rows and all four heads exact old | exact old | only a proven pre-CAS rollback; close reservations and require a new authorization |
| only one consumption/product row, wrong row, wrong head, missing prior state, or unreadable state | any | terminal ambiguity and quarantine |
| database old/missing after a consumption CAS | anchor desired/ahead | quarantine rollback; product remains burned |
| database desired/ahead without exact consumption request | anchor old/different | quarantine fork/tamper; product remains burned |
| CAS return unknown | any unproved state | terminal ambiguity; later exact confirmation may close evidence only and never resume |

The recovery reader itself never writes, repairs, retries, refunds, unconsumes, deletes, changes a head, reopens a
product pair, reconstructs a receipt, spends broker authorization, or calls a source/provider. It may hand an exact
pre-existing request only to the narrowly scoped anchor writer/finalizer allowed by the table; that action can settle
durable truth but cannot return an execution receipt. Even later proof of exact commit never resumes that product.

## Process ownership and authenticated IPC

The owner-attended parent harness owns the qualification window and is the only process allowed to create the
disposable attestor child. It uses one fixed manifest-bound executable, child entrypoint, working directory, argument
vector, and minimal environment allowlist; `shell` is false. No caller supplies a path, argument, environment key,
file descriptor, command, loader, module, or child option. The child cannot spawn descendants, open a listener or
socket, access stdin after its one frame, or survive the parent deadline.

The parent sends exactly one length-delimited authenticated launch record on the child's stdin. The child sends at
most one length-delimited platform-signed private settlement record on stdout and then exits; stderr is a fixed-size
sanitized status channel with no raw values. The records contain exactly: frame schema/direction, sequence `1`, body
length, canonical body digest, manifest digest, parent/child product digest, IPC key ID/revision, and authentication
tag. Launch body maximum is 32 KiB; settlement body maximum is 64 KiB; extra frames, bytes after a frame, partial
frames, wrong direction/sequence, non-canonical bodies, timeouts, or authentication failures are terminal. Parent and
child use distinct IPC keys. There is no bidirectional request protocol, listener, network socket, retry, or resume.

The child owns stages 1-31 and its lexical secrets. It emits its settlement only after stage 31 reaches one exact
durable result, clears references, and then exits. It cannot run cleanup. The parent authenticates the frame and exit;
its separately accepted cleanup observer owns stages 32-34 and may inspect only the pre-reserved process/root/resource
set after exit. The separately credentialed parent finalizer owns stage 35 and may append only the predetermined
accepted or terminal row. A different report-only reviewer owns stage 36, receives one fixed sanitized review packet,
and cannot write durable state. A pure public projector then combines the fixed final disposition class with the
review reference and creates one sanitized object; on an earlier terminal path it uses `not_submitted` and the all-zero
review sentinel. Candidate assembly must verify an accepted stage-36 review product and evidence digest in addition
to stage-35 acceptance.

Process creation, IPC, child exit/termination, cleanup, finalization, and projection counts are all included in the
owner body ceilings. Failure to prove authenticated child exit forces termination at most once, closes the attempt,
and still requires after-exit cleanup; it can never turn missing child output into acceptance.

## Capsule-held records and closed public outcomes

Private stage records are exact branded frozen object identities created only inside the capsule. They may contain
authenticated digests and protected references required for the next stage but are never serializable public DTOs.
Every reference is cleared on settlement. JavaScript memory zeroization is not claimed.

Every terminal path returns the same exact closed public schema. It contains: schema version `1`; LIVE-460 contract
product/tree; source-owner and runner product/tree; one aggregate accepted-product-set digest; exactly one of
`rejected_before_spend`, `terminal_owner_authorization_spent_or_uncertain`,
`terminal_invocation_authorization_spent_or_uncertain`, `terminal_recheck_or_context_finalization_failed`,
`terminal_source_lookup_failed`, `terminal_source_invocation_failed_or_uncertain`,
`terminal_source_raw_validation_failed`, `terminal_source_intake_failed`,
`terminal_supplementary_provider_failed_or_uncertain`, `private_evidence_pipeline_failed_or_uncertain`, or
`private_target_runtime_attestation_accepted_for_exact_candidate_proposal_only`; fixed integer counts for owner uses,
broker uses, source lookups/invocations, the five
ordered provider invocations, platform signatures, cleanup observations/signatures, child creations, launch frames,
settlement frames, finalizations, and review submissions; `review_state` (`not_submitted`, `submitted_pending`,
`rejected`, or `accepted`);
an accepted review-product/evidence digest or the all-zero sentinel; the eight false authority grants; the complete
false prohibited-effect grant map; and the digest of the canonical public object. Fields are never absent, nullable,
extended, or outcome-dependent. Each count is zero or one and cannot exceed the owner body's ceiling.

The public object contains no authorization/body/nonce/context/cleanup/receipt/request/anchor digest, trusted time,
database locator, key, manifest internals, candidate/attempt identity, provider subject or state, host value, path,
PID, endpoint, command, error text, stack, or reversible transform. A pre-source failure uses the same schema and zero
counts for effects not reached. The projector is pure: no key, database write, source/provider, host, process, network,
clock, or recovery access.

The capsule cannot return `private_target_runtime_attestation_accepted_for_exact_candidate_proposal_only` until all 36
LIVE-460 stages settle. This design covers only construction plus owner authorization and cannot clear a blocker.

## Repository implementation and deterministic tests

Owner-store repository tests may use local PGlite, fixed database time, repository-only distinct keys, synthetic
sealed bodies, fixed accepted product catalogs, and fixed preflight/context/cleanup reservation records. They prove
schema, authentication, append-only history, exact replay, concurrency, crash/commit uncertainty, product-pair
uniqueness, restart, tamper, deletion, reordering, key rotation/revocation, exclusive expiry, and hostile input only.
They cannot construct or import the production capsule.

Future dormant capsule tests enter only through LIVE-440/LIVE-450's direct-module fixed-scenario enum. The owning
module mints all synthetic stage identities. The caller cannot provide a database, key, source, raw record, provider,
signer, verifier, checkpoint, clock, nonce, callback, manifest, receipt, error object, or arbitrary scenario content.
The deterministic seam is absent from every barrel and production consumer and can never call the production root.

Static verification must prove:

- no exported dependency-taking factory, provider registry, generic locator, callback, dynamic import, or fallback;
- no barrel, application, API, UI, worker, scheduler, Idea Lab, Hermes, MCP, plugin, startup, or ordinary-test consumer;
- no source/provider call in owner-store tests or contract-only modules;
- exact accepted source-owner seam and one protected production-root consumer only when separately authorized;
- all current capsule, authorization, key, database, source/provider, native, network, and runtime actuals are zero; and
- all approval, qualification, candidate, activation, network, command, lease, and execution grants are false.

Every transitive production import must be inert. Import evaluation may define types, constants, and pure parsers only;
it cannot read environment, host, process, filesystem, clock, key, credential, database, trust registry, manifest,
anchor, source, provider, network, or native state; allocate a process/resource; register a handler; start a timer; or
construct the capsule graph. Tests walk the complete transitive import graph and fail on a top-level effect.

## Implementation order after acceptance

Architecture acceptance permits no implementation automatically. Later blocks remain separate:

1. inert owner-native authorization, owner-present issuer, key-role, manifest, trust-registry, and anchor contracts;
2. authenticated registration/nonce store and composite owner-attempt anchor with local PGlite/fake-anchor tests;
3. read-only preflight validation contract and implementation;
4. atomic owner-consumption/exact-product-attempt ledger, migration, anchor settlement, and post-transaction recheck
   that stop before broker spend;
5. the five provider designs, then contracts, inert implementations, and separately authorized protected
   qualifications in fixed LIVE-460 order;
6. privacy transform, platform signer, PostgreSQL attestation, independent high-water, verifier, and after-exit cleanup
   contracts/implementations/qualifications;
7. inert production-capsule manifest and construction contracts after every component above is accepted;
8. dormant same-module capsule assembly, child entrypoint, parent harness, IPC, finalizer, and projector only after the
   complete transitive import graph is proved inert;
9. the LIVE-440 source-owning implementation last, without changing its frozen seam; and
10. separately owner-authorized native qualification, cleanup, different review, then only later candidate assembly.

Each product receives full non-native producer verification and a different independent zero-repair review. Native,
key, production-database, provider, network, and deployment actions remain separately owner-gated.

## Prohibited in LIVE-470

LIVE-470 must not create or implement a capsule, manifest, authorization, issuer, store, writer, migration, key,
provider, privacy transform, signer, verifier, high-water adapter, cleanup observer, source bridge, or runner; import or
modify the source-owning module; read a host/process/OS/filesystem/environment/clock/credential/key value; reserve a
nonce; call a database/source/provider; sign; create a process/listener/socket/timer; contact Hermes/MCP/plugin/VPS;
wire runtime use; deploy; change DNS/hosting; clear a blocker; or grant authority.

## Architecture acceptance

Acceptance requires exact LIVE-440/450/460 binding; the same-module lexical production graph whose runner accepts only
the two sealed authorization envelopes; one owner-root-pinned trust chain and rollback-protected manifests; a complete
owner authorization body/operation budget; exact key roles/lifecycle; exact PostgreSQL schema and grants; composite
owner-attempt rollback anchor; atomic owner-consumption/product-pair closure; exact post-transaction recheck; closed
uncertainty/recovery matrix; one attempt per exact product pair; fixed parent/child/cleanup/finalizer/projector and IPC
ownership; closed public terminal schema; transitive import inertia; separate deterministic test seams; dependency-
ordered downstream blocks; zero current effects; and a different independent report-only architecture review.

Acceptance freezes design only. It grants no implementation, native execution, key/database/provider access, source
modification or invocation, attestation, candidate, physical qualification, activation, deployment, hosting, or DNS
authority.

## Reevaluate

Reevaluate before every implementation block above and before any owner authorization issuance, protected key or
database configuration, capsule construction, provider/source access, native qualification, runtime wiring, or
deployment.

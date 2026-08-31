# CR-7B isolated runtime independent security review

**Reviewed base:** `14de468999b1ebf4584c13026114d40a0f66cea7`
**Mode:** Two independent, read-only adversarial reviewers
**Producer independence:** Neither reviewer authored any reviewed CR-7B commit.
**Native effects:** None. No process/service start, provider call, credential access, network access, or host mutation occurred.

## Initial disposition

Blocked. The 40/40 focused suite passed at the reviewed base, but it did not cover the confirmed failures below. The reviewers prohibited native qualification until remediation and clean re-review.

## Confirmed findings and disposition

| Finding | Initial severity | Remediation disposition |
|---|---:|---|
| Replay created a thread before ledger claim and could return the wrong resume handle | High | Fixed: claim occurs before thread start/resume; replay returns before thread creation; raw handle removed from the public result |
| Turn settlement trusted stale notifications instead of the correlated `turn/start` response | High | Fixed: correlated response supplies the exact turn ID; all pre-response notifications are rejected without retention |
| Output-token maximum was enforced only after provider spending | High | Native gate: explicitly `provider_output_cap_unenforced`; the value is accounting/settlement policy, not a provider-side authority limit |
| Permit expiry trusted caller-supplied time | High | Fixed: both ledgers use a broker-owned clock and reject invalid or regressed time; SQLite persists the last observed time |
| Topology attestation was an unkeyed caller-forgeable declaration | High | Fixed closed: it is now explicitly an untrusted declaration and can never make native qualification eligible |
| Loopback WebSocket did not authenticate the executor peer | High | Native gate: explicitly `executor_peer_unauthenticated` |
| Requested environment did not prove where execution occurred | High | Native gate: explicitly `execution_receipt_missing` |
| Pinned child identity trusted spawner-reported metadata | High | Native gate: explicitly `native_child_identity_unverified` |
| Stdin-close failure could skip termination and listener cleanup | High | Fixed: cleanup steps are independent, best-effort, idempotent, and exercised with throwing fakes |
| Failed/interrupted turns were returned as completed | Medium | Fixed: public disposition now follows exact terminal truth |
| Raw request driver was exported and could bypass claim ordering | Medium | Fixed: driver is module-private; runtime owns the dispatch path |
| Usage/outcome settlement accepted partial or invalid runtime shapes | Medium | Fixed: exact keys, integer values, allowed outcomes, and no extras are required |
| Settlement errors could leak raw durable-store errors or retry blindly | Medium | Fixed: errors become safe protocol uncertainty and restart reconciliation remains authoritative |
| Event cap was checked after observer mutation/settlement | Medium | Fixed: capacity is reserved before observation |
| Oversized stdout chunk could allocate before the frame bound | Medium | Fixed: chunk bytes are rejected before decode/concatenation; fatal framing initiates cleanup |
| Lexical path checks did not prove native path identity | Medium | Native gate: explicitly `path_identity_unverified` |
| Static plist substring checks could miss unsafe additions | Medium | Fixed for repository templates: exact file digests plus forbidden stream/socket keys; any template change requires deliberate pin update and review |
| Service templates persisted raw stdout/stderr | Medium | Fixed: raw service output paths were removed |
| Public result serialized the raw native thread ID | Medium | Fixed: only the digest is public; a scoped broker-private durable binding supports resume and is erased on unsafe/retired states |
| Local close did not prove remote turn/descendant cancellation | Medium | Native gate: explicitly `remote_cancellation_unverified` |
| Claimed calls remained live after restart unless the caller remembered a recovery method | High | Fixed: the SQLite constructor automatically makes all claimed calls ambiguous, quarantines bound threads, clears raw bindings, and verifies no claimed row remains before exposing the ledger |
| Permit shape allowed forged duration/call-budget fields outside the issuer policy | High | Fixed: permits require exact fields, identifiers, digest, model, one-to-three calls, and an expiry after now but no more than five minutes away |
| Trusted clock validation occurred outside the serialized claim transaction | High | Fixed: trusted-clock read, monotonic high-water update, validation, and claim/dispatch preparation are serialized under `BEGIN IMMEDIATE`; validation errors retain the advanced high-water |
| A claim just before expiry could reach or continue provider work after permit expiry | High | Fixed: the broker re-authorizes the exact claimed ticket immediately before `turn/start`; a permit-owned timer closes the transport and settles ambiguity on in-turn expiry |
| An executor-signed `remote_confirmed` label could claim descendant-safe cancellation | Medium | Fixed: the executor can report interruption only; confirmation requires a separately pinned collector signature over the interrupt acknowledgement and an independently observed empty descendant set |
| Hostile SQLite triggers could erase durable spend, replay, or trust records | High | Fixed: all three private security databases reject every unexpected schema object and exact-column drift before use, then verify inserted state by readback |
| A public helper accepted caller-supplied resolved trust pins without owner high-water anchoring | High | Fixed: the unanchored helper is module-private; the public verifier requires the durable registry and owner-signed high-water checkpoint |
| Owner checkpoint did not bind the exact resolved-pin projection | High | Fixed: registry evidence and the owner signature include `resolvedPinsDigest`; bundle verification rejects caller-supplied pin substitution |
| Trust manifests did not prove distinct runtime identities and actual key material | High | Fixed: broker, executor, and collector identities and key fingerprints must be pairwise distinct, and the owner signing key cannot be reused for a runtime role |
| Parser-tolerated trailing DER bytes let one Ed25519 key acquire distinct raw-byte fingerprints | High | Fixed: every SPKI must equal the canonical DER re-export and canonical base64url encoding; fingerprints and role separation use canonical key bytes; a semantic-key-alias regression test covers the exploit |
| Queued completion frames could settle success after the broker clock crossed permit expiry but before the timer callback | High | Fixed: the runtime re-authorizes the claimed ticket before every observed notification and converts expiry to `broker_permit_expired` ambiguity; the timer remains as the idle-turn backstop |
| Schema validation checked object and column names but not constraints or index definitions | Medium | Fixed: every protected table and index must match its complete normalized `sqlite_master.sql` definition as well as the exact object and column projections; a same-column weakened-CHECK database is rejected |

## Residual native boundary

Repository rehearsals remain effect-free and cannot authorize native qualification. Advancement requires independently verified authenticated executor IPC, actual child UID/image/signature/argv/cwd/environment identity, realpath/owner/mode/device/inode checks, executor-bound turn receipts, provider-side output authority, and confirmed remote cancellation/descendant cleanup. The current topology evaluation always returns `eligibleForDisposableQualification: false`.

## Re-review

The re-review rounds found further defects in uncertain-thread ownership, automatic restart recovery, permit validation and expiry enforcement, clock serialization, SQLite schema integrity, cancellation independence, canonical key identity, and owner-rooted trust anchoring. The local remediation now uses broker-global ownership and durable digest tombstones; automatically reconciles every claimed call before a restarted ledger is exposed; binds the endpoint and clock in schema-v4 state; rejects unexpected tables, views, indexes, columns, triggers, constraints, and index definitions; rechecks permit authority at dispatch and before every observed notification; separates executor interruption reporting from collector-signed cancellation proof; rejects non-canonical SPKI aliases; and makes the owner checkpoint bind the exact resolved-key projection. Tests cover immediate ambiguity, restart recovery, exact replay, cross-permit reuse, restart-persistent reuse denial, hostile triggers, weakened same-column schemas, expired dispatch, queued completion at expiry, in-turn expiry, key/identity reuse, semantic-key aliases, pin substitution, and independently observed descendant absence.

The producer-focused suite passes 62/62, the combined suite passes 411 of 413 with two intentional platform skips, and type checking, lint, production build, rendered-route tests, and diff validation pass. Two independent read-only re-reviews of the stable local diff returned `accepted_with_residual_native_blockers`: no evidence-backed repository finding remains, retained evidence is content-free and bounded, and no path reports native eligibility. No further repository review is required unless this security diff changes. The authenticated-executor, evidence-bundle, owner-rooted trust-pin, durable pin-chain, high-water checkpoint, and owner-attended package contracts add no native evidence and do not advance the native gate. No GitHub commit or push is made while the owner-requested local-only hold is active through 2026-09-01.

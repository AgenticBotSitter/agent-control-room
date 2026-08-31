# CR11B-AUTO-060 independent security, authority, durability, and replay review

**Disposition:** `REJECTED`  
**Exact reviewed commit:** `f77108fc3c556970bff4cc94c4b952a0336a8cac`  
**Exact reviewed tree:** `8993df9e9c70523d81aad0c9eb37d5da83c266fe`  
**Compared parent:** `081e492b7bb81a5ab71f140aefb2dc7f2c495ca2`  
**Branch observed:** `codex/cr11b-auto-060-proof-ingress`  
**Review date:** 2026-08-30  
**Reviewer:** different independent Codex security and authority reviewer; not the AUTO-060 implementation author  
**Mode:** owner-authorized, repository-only, report-only review; no implementation or prior-report change, install,
download, credential use, native access, provider/service contact, GitHub operation, network contact, deployment, or effect

## Exact scope and preserved evidence

Preflight returned the exact requested commit, tree, parent, branch, and an empty porcelain status. The candidate changes
twelve paths relative to its accepted AUTO-050 parent: five proof-ingress source/export paths, the dedicated hostile test,
the contract, acceptance record, build status, completion program, decision log, and package test registration. The diff
contains 1,883 insertions and 3 deletions. I inspected every changed path and the relevant accepted AUTO-050 contracts and
reports, ADR-112, the governing security contracts, and the complete delegation-review skill.

The accepted AUTO-050 reports independently retain SHA-256 values
`866e00877956b05f7623814e1b6ba34a4276518465557bc314a2731d9c3288f4` and
`fa6580952fff46798bf10e9562bd824db3507571d4bec1001eb5c10d6886a611`. This review does not change their dispositions.

## Commands and independently observed results

| Command or probe | Independent result |
|---|---|
| `git rev-parse HEAD HEAD^{tree} HEAD^`, `git status --short`, and exact diff inspection | Exact commit, tree, parent, clean pre-report tree, and twelve changed paths confirmed |
| `node --import tsx --test tests/ready-frontier-production-proof.test.ts` | 13/13 passed; zero failures or skips |
| `npm run test:cr11b` | 112/112 passed; zero failures or skips |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| `git diff --check 081e492..f77108f` | Passed |
| Independent noncanonical-signature probe | A canonical Ed25519 owner signature ending in `Q` was changed to a different base64url string ending in `R`; the decoded 64 bytes remained equal and the trust-bundle verifier accepted the noncanonical string |
| Independent assessor, lifecycle, chronology, and open-file probe | Reproduced unsigned observation acceptance, backdated ledger assessment, terminal revocation reactivation, and successful reads after mode/link-count loss; exact output is recorded below |
| Static import/export and call review | No network, provider, destination, protected-reference resolver, consumer, activation, claim, lease, dispatch, execution, deployment, or external-effect path found |

Passing producer tests and the properties that remain correct do not override the concrete findings below.

## Properties that remained safely negative

The exact verifier does bind the AUTO-050 assessment, requirement digest, evidence class, proof authority, ordered binding
codes, aggregate evidence digest, scope, trust bundle, identity/key IDs, and proof chronology before deriving a normal
observation. Canonical SPKI re-export rejects alternate key encodings. For required independent verification, the normal
envelope path rejects shared identity ID, key ID, key digest, or owner-signed independence-domain digest. The strict input
snapshotting on verifier and assessor inputs rejects accessors and host Proxies before their callbacks or traps enter those
boundaries.

The normal ledger path re-verifies stored signed packages, row HMACs, ordered state HMAC, exact checkpoint, canonical JSON,
and append sequence on restart. The supplied tamper and rollback cases fail closed. The projection contains only safe
scope/assessment IDs, gate/status pairs, counts, blockers, and literal false capabilities. Nine normal fixture proofs still
produce zero qualified proofs, retain all nine blocking gate codes, and cannot enable owner approval, activation, consumer
construction, protected-reference resolution, network contact, claims, leases, dispatch, execution, or effects.

Those negative-authority properties constrain impact: none of the findings below produced `qualified`, owner approval,
activation, an operational control, a consumer, a network call, a provider contact, a deployment, or an external effect.
They do fail AUTO-060's central claim that observed fixture evidence, trust lifecycle, replay, and private ledger state are
exactly authenticated.

## AUTO060-IR-001 — noncanonical base64url signature aliases are accepted

**Severity:** medium cryptographic-canonicalization and artifact-identity defect; no production authority

The shared signature schema checks only an 86-character base64url alphabet string. `validSignature` decodes that string
and asks Node to verify the resulting bytes, but unlike the SPKI path it never requires a 64-byte decode followed by an
exact base64url round trip. A 64-byte base64url value has unused bits in its last character. Different strings can
therefore decode to the same Ed25519 signature bytes.

The independent probe signed an otherwise valid trust bundle. Its canonical signature ended in `Q`. Replacing only that
tail with `R` produced a different string whose decoded bytes were identical. The candidate accepted it as the owner
signature:

```json
{"stringsDiffer":true,"decodedBytesEqual":true,"noncanonicalOwnerSignatureAccepted":true,"canonicalTail":"Q","acceptedTail":"R"}
```

The same schema and decoder serve owner, issuer, and independent-verifier signatures, so the alias class applies at all
three seams. This contradicts the canonical Ed25519 acceptance requirement and permits multiple textual identities for
one cryptographic signature, with downstream envelope/replay digests depending on which alias was supplied.

**Required remediation:** add one captured canonical Ed25519-signature parser that decodes exactly 64 bytes and requires
`supplied === decoded.toString("base64url")` before any signature verification. Use it for owner, issuer, and independent
signatures. Add hostile tail-alias tests for all three roles and confirm textual aliasing cannot alter replay behavior.

## AUTO060-IR-002 — the exported assessor accepts unsigned observations and backdates ledger truth

**Severity:** high within AUTO-060's evidence-integrity purpose; impact remains fixture-only and non-authorizing

`assessReadyFrontierProductionProofsV1` is publicly exported and accepts caller-provided observations. Its observation
parser checks the strict shape, deterministic observation ID, and a public SHA-256 digest, but does not receive an envelope,
issuer signature, independent signature, ledger HMAC, checkpoint, or an unforgeable ledger-derived capability. The
assessor then checks only shared assessment scope and current identity/key IDs. An ordinary caller can therefore create a
fully synthetic observation, recompute its public digest, and make a gate appear `observed_unqualified` without ever using
proof ingress or the ledger.

The independent probe used a valid signed fixture trust bundle but supplied an observation for which no envelope or
signature was created or verified. The exported assessor accepted it and counted the gate as observed:

```json
{"unsignedPublicObservationAccepted":true,"unsignedGateStatus":"observed_unqualified","activationStillFalse":true}
```

The store-backed path has a second chronology defect. `ReadyFrontierProductionProofStoreV1.assess` passes every stored
observation to the assessor regardless of `evaluatedAt`. The assessor requires evaluation no earlier than the current
bundle's signed issue time, but never requires evaluation at or after the bundle's ledger receipt or a proof's observation,
issue, and receipt. After recording a valid proof received at `20:23`, the probe requested assessment at `20:20:30`, before
that proof was observed at `20:21`, issued at `20:22`, or received at `20:23`. It was still counted:

```json
{"ledgerTimeTravelAccepted":true,"evaluationPrecedesObservation":true,"evaluationPrecedesIssue":true,"evaluationPrecedesReceipt":true}
```

This violates the contract statement that assessment consumes only ledger-derived observations and the hostile future
chronology boundary. The result remains blocked, but its claimed evidence status is not authentic current ledger truth.

**Required remediation:** remove or capability-bind the public raw-observation assessor. The accepted assessment path must
consume packages obtained from an authenticated ledger read or independently re-verify the exact envelope, trust bundle,
assessment, and signatures. Bind evaluation to ledger chronology: a current bundle and every considered observation must
have been recorded no later than `evaluatedAt`, or future records must be excluded under an explicit authenticated as-of
model. Add hostile unsigned-observation, public-redigest, pre-bundle-receipt, pre-observation, pre-issue, pre-receipt, and
mixed-artifact-chain tests through every exported assessment path.

## AUTO060-IR-003 — terminally revoked identities can become active and issue proofs again

**Severity:** high trust-lifecycle defect within the fixture verifier; no production authority

Each trust bundle is checked in isolation. The ledger enforces revision, prior digest, and increasing issue time, but does
not compare identity/key lifecycle with prior bundles. Consequently, a later owner-signed bundle can change a terminally
revoked identity back to `active`, with the same identity and key, and the current-bundle proof verifier will use it.

The independent probe recorded an exact linear chain: revision 1 active, revision 2 terminally revoked, and revision 3
active again for the same identity ID, key ID, public key, and key digest. All three bundles were accepted. A new proof
signed by the reactivated key was then recorded as `observed_unqualified`:

```json
{"terminalRevocationReactivationAccepted":true,"reactivatedProofStatus":"observed_unqualified","activationStillFalse":true}
```

This directly contradicts `active or terminally revoked state`. An owner-signed revision may narrow or revoke fixture
trust, but the accepted contract does not allow a terminal revocation to be erased by the next row.

**Required remediation:** validate every new bundle against the complete authenticated trust history. Preserve terminal
tombstones for identity IDs, key IDs, public-key/key digests, and any other role identity the contract treats as revoked;
they must not return active after direct revocation, omission, or alias substitution. Enforce monotonic revocation time and
test direct reactivation, remove-and-readd, same-key/new-ID, same-ID/new-key, key/domain swapping, and verifier-role
variants across restart and concurrent store instances.

## AUTO060-IR-004 — an exact proof replay stops being inert after trust advances

**Severity:** medium replay-semantics and availability defect; no false proof acceptance

`recordProof` selects the current bundle and verifies the incoming envelope against it before looking up an existing
`proofId`. An exact proof recorded under revision 1 necessarily binds revision 1's bundle ID, revision, and digest. Once
revision 2 is current, replaying that exact original package reaches the current-bundle scope comparison and fails before
the exact-record lookup can return the stored observation. The implementation therefore honors exact replay only while the
proof's bundle remains current, although the contract says an exact repeated proof is inert without that qualification.

This is a fail-closed result, not an authority bypass, but it breaks deterministic retry/recovery behavior exactly when a
trust update has occurred.

**Required remediation:** perform an authenticated existing-ID comparison that can recognize the complete exact stored
assessment/envelope/receipt package before current-bundle admission of a new proof. Return the stored observation only for
byte/canonical exact replay; retain drift rejection for every changed field. Add exact old-proof replay after active,
revoking, and unrelated trust revisions, full-capacity replay, restart replay, and competing-store replay tests.

## AUTO060-IR-005 — open ledger operations do not revalidate the promised private file boundary

**Severity:** medium storage-confidentiality and exact-schema contract defect; no current external effect

Path privacy and exact SQLite schema are checked only during construction. The store does not retain the path or opened
file identity, and `#verify` does not repeat the owner/mode/link-count or exact-schema check. This conflicts with the
contract's explicit statement that schema, columns, indexes, file owner/mode, and link count are verified on every read and
mutation.

The independent probe constructed the ledger in a private directory, recorded valid state, changed the database mode to
`0644`, created a hard link so `nlink` became 2, and then called the normal read path. The read succeeded and returned the
stored observation:

```json
{"privacyLossReadAccepted":true,"databaseMode":"644","databaseLinkCount":2}
```

The same structural gap means an added table, index, trigger, or other schema behavior after construction is not checked by
the normal read/mutation verifier. Row/state HMACs still catch many content changes, but they do not prove the promised
ongoing private-path and exact-schema boundary.

**Required remediation:** bind the opened database to an exact retained file identity and revalidate owner, mode, regular
file, symlink status, device/inode, and link count before and after every read and mutation. Re-run the exact schema/object
check at those boundaries and account for SQLite sidecars under the selected journal mode. Add hostile open-store chmod,
hard-link, path replacement, extra table/index/trigger/view, and pre/post-transaction drift tests that fail before returning
state or accepting an append.

## Disposition and residual boundary

Exact candidate `f77108fc3c556970bff4cc94c4b952a0336a8cac` is rejected. The immutable report must be retained as negative
evidence. Remediation requires a new exact commit and a different independent reviewer. Producer evidence did not decide
acceptance.

The rejection does not weaken the accepted AUTO-050 boundary and grants no production proof, owner approval, production
root or key custody, durable checkpoint custody, hosted database qualification, multi-process qualification, consumer,
protected-reference access, scheduling, claim, lease, dispatch, execution, recurrence, deployment, or external-effect
authority. All nine production gates remain blocking.

`REJECTED`

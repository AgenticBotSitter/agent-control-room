# CR11B-AUTO-110 first-remediation independent re-review

**Verdict:** `ACCEPTED_EFFECT_FREE_REPOSITORY_SNAPSHOT`

**Exact reviewed commit:** `f3b64498c2313c86d50f63e4c62cf7c7eba5fcd6`

**Exact reviewed tree:** `d2ab467adf2032504f31a0b6d1c852f77a3ddf58`

**Remediation parent:** `29fbce7e61a2f952cc9dd1e0fb34e912c2bef3ee`

**Rejected original candidate:** `7750c9b179d9f07ac05041ff4ac0dd19dd7766e7`

**Rejected original tree:** `86ff495485cb649c9cb458c63aeaca443f5016fa`

**Immutable original-review report:** `docs/reviews/CR11B_AUTO_110_INDEPENDENT_REVIEW.md`

**Immutable original-review SHA-256:** `a71a54a8a2dc8af6243e5c9a2b36da77b1c59bde968b1b139e7ccb742f5ac626`

**Review date:** 2026-08-31

**Reviewer:** different independent Codex security reviewer; not the implementation author or original reviewer

**Mode:** local repository-only, effect-free, report-only remediation re-review. No implementation, existing document,
test, prior report, package, dependency, Git-state, provider, host, process, database, credential, protected-reference,
service, configuration, migration, backup/restore, cleanup, consumer, deployment, or external-effect change.

**Report SHA-256:** calculated after the final report write and supplied in the handoff; embedding the digest here would
change the file digest.

## Decision

Exact remediation commit `f3b64498c2313c86d50f63e4c62cf7c7eba5fcd6`, tree
`d2ab467adf2032504f31a0b6d1c852f77a3ddf58`, is accepted only as the frozen effect-free repository snapshot.

`AUTO110-IR-001` is closed. I independently loaded the original implementation from candidate
`7750c9b179d9f07ac05041ff4ac0dd19dd7766e7` and reproduced the finding: two unrelated caller-selected direction digests
and times each built and parsed a request claiming `phasePreparationAuthorized: true` and the owner-direction kind.
Every live flag remained false, matching the finding's exact false-repository-provenance scope.

The remediation removes direction identity, digest, time, and object fields from the strict public builder input. The
builder privately consumes one fixed repository-accepted direction snapshot. Both construction and parsing require its
exact ID, source, effect-free scope, accepted time, inner digest, complete snapshot digest, and three false live-authority
facts. Fully re-digested direction-ID, accepted-time, source, scope, authority-fact, inner-digest, and top-level-binding
forks fail closed. A caller can no longer choose owner-direction provenance while obtaining
`phasePreparationAuthorized: true`.

The exact accepted AUTO-100 implementation/review lineage, all 36 canonical blockers, ordered stages and requirements,
request ceilings, disabled disposition, and safe projection remain intact. All request, disposition, and projection
live/effect/protected-reference/host/database/process/migration/backup/cleanup/consumer/deployment capabilities remain
false. I found no new correctness, authority, mutation, chronology, accessor/Proxy, digest-substitution, source-lineage,
or safe-projection defect within the reviewed AUTO-110 boundary.

Acceptance does not authorize a rehearsal or satisfy a live gate. Host contact remains blocked until all 36 live gates
have fresh accepted evidence and the owner issues a separate strong-factor exact effect window with protected access,
operations, claim and marker, time, rollback, cleanup, and evidence bindings.

## Frozen scope and path review

Preflight confirmed a clean checkout on `codex/cr11b-auto-110-owner-rehearsal-packet`, exact HEAD commit and tree, the
exact remediation parent, the rejected original commit/tree, and the unchanged prior-report digest. No branch switch or
Git mutation occurred.

The remediation commit changes seven declared paths:

- `src/operations/v1/postgres-rehearsal.ts`;
- `tests/operations-postgres-rehearsal.test.ts`;
- `docs/CR11B_AUTO_110_POSTGRES_REHEARSAL_CONTRACT.md`;
- `docs/CR11B_AUTO_110_ACCEPTANCE.md`;
- `docs/BUILD_STATUS.md`;
- `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`; and
- `docs/CR3_DECISION_LOG.md`.

The intervening parent adds only the immutable original negative report. The implementation remediation does not change
a migration, package, lockfile, provider adapter, operational configuration, protected value, or live-effect client.
The exact-helper, readiness-source, error, and security dependency blobs used by the historical in-memory replay are
identical between the original and remediation commits.

## Independent reproduction of `AUTO110-IR-001`

The historical replay read the exact original TypeScript source with `git show`, transpiled it in memory, and mapped its
imports to local dependency blobs proven identical at the original and remediation commits. It wrote no source or
temporary file.

Two unrelated caller cases produced:

```text
[{"label":"a","accepted":true,"phasePreparationAuthorized":true,"ownerPhaseDirectionKind":"owner_direction_to_prepare_auto110_not_live_effect_authority","hostContactAuthorized":false,"databaseContactAuthorized":false,"grantsExternalEffects":false},{"label":"b","accepted":true,"phasePreparationAuthorized":true,"ownerPhaseDirectionKind":"owner_direction_to_prepare_auto110_not_live_effect_authority","hostContactAuthorized":false,"databaseContactAuthorized":false,"grantsExternalEffects":false}]
```

The result independently reproduces the original defect without widening it: the original request falsely attributed
phase preparation to the owner, but still could not contact a host/database or grant an external effect.

## Remediation analysis

### Exact repository-accepted direction

`requestInputSchema` now contains only request ID, source packet, source disposition, requested time, and expiry. It is
strict, so caller-supplied direction ID, digest, recorded/accepted time, or direction object is rejected. The builder
selects the private `acceptedOwnerPhaseDirection` instead of any caller value.

That snapshot fixes:

- direction ID `owner-direction:operations:postgres-rehearsal:auto110:1`;
- source `repository_accepted_owner_direction_snapshot`;
- scope `auto110_effect_free_packet_preparation_and_independent_review_only`;
- accepted time `2026-08-31T16:58:35.000Z`;
- `liveEffectAuthorization: false`;
- `protectedReferenceAuthority: false`; and
- `hostContactAuthority: false`.

The inner `directionDigest` is derived from exactly those seven facts. A second digest pins the complete snapshot,
including its inner digest. Parsing first applies a literal, strict exact schema, then verifies the inner digest, complete
snapshot digest, and equality to the privately captured digest. The request separately binds the exact direction ID and
inner digest before verifying the outer request digest.

Four public-builder caller-direction extra families were rejected. Nine independently constructed parser forks were
also rejected after recomputing every affected inner and outer digest: direction ID, accepted time, source, scope, all
three false authority facts, top-level direction ID, and top-level direction digest. This closes both caller construction
and serialized-parser substitution paths.

### Mutation, accessors, Proxies, and chronology

The accepted private source snapshot is frozen and contains only primitive own data. Public parsed objects are defensive
exact snapshots: changing a returned direction's accepted time invalidates later parsing rather than changing the
private accepted source.

Independent nested probes placed an own accessor and a throwing Proxy at the embedded direction boundary. Both were
rejected with zero getter calls and zero Proxy traps. The same probes against the 36-element blocker list also executed
zero accessors and zero traps. Public stage and requirement registries remain frozen.

The fixed accepted direction time is no longer caller-selected. Both builder and parser require `requestedAt` not to
precede either that accepted time or the source disabled disposition, require expiry after request, and retain the exact
3,600-second maximum request lifetime. Disposition chronology remains no earlier than the request. Re-digested accepted-
time forks and pre-source/overlong request cases fail closed.

### Source lineage and all 36 blockers

The request still embeds and re-runs the accepted AUTO-100 packet and disabled-disposition parsers. It retains exact
accepted AUTO-100 implementation `34750ed8ec5cf34134d166505f3df50897afe3f7` and review SHA-256
`aa2116b832ed6e5587c72705dcf6dc826f8ef0e7201c5b284c7876b93f53c0a9` bindings. Packet and disposition IDs/digests
must match their complete embedded objects.

The independent fixture contained exactly 36 unique blockers in the canonical source order. The request list equaled
the source packet list element-for-element. Re-digested commit, review, packet-ID, packet-digest, disposition-ID,
disposition-digest, and blocker-value forks all failed. The request, disabled disposition, and safe projection retained
the same exact blocker list.

### Negative authority and safe projection

I changed every false capability to true one at a time and recomputed the applicable request, disposition, or projection
digest. All 53 forks were rejected:

- 29 request denial/capability facts;
- 15 disabled-disposition effect/authority facts; and
- 9 safe-projection capability facts.

The projection contains exactly 23 safe fields: request/disposition identities and digests, generic Hostinger target
class, blocked status and reason, preparation truth, blocker count/list, attempt/time ceilings, nine false capabilities,
and its digest. It omits the owner-direction object/digest, embedded readiness objects, protected host/access values,
credentials, hostname/address/port/username, connection string, raw evidence, and deployable configuration.

Static imports remain limited to Zod, canonical digest/redaction helpers, operations errors/exact parsing, and the
effect-free AUTO-100 readiness parsers. Focused static coverage found no network, host, process, PostgreSQL, credential,
protected-reference resolver, service-control, provider, migration, backup/restore, cleanup, consumer, or deployment
client.

## Commands and results

| Command or check | Result |
|---|---|
| `git status --short --branch`, recent log, `git rev-parse HEAD`, and `git rev-parse HEAD^{tree}` | Clean pre-report checkout; exact remediation commit/tree and current branch confirmed |
| Exact `git cat-file` and tree checks for remediation and original commits | Both immutable commit objects and exact supplied trees confirmed |
| `sha256sum docs/reviews/CR11B_AUTO_110_INDEPENDENT_REVIEW.md` | Exact unchanged SHA-256 `a71a54a8a2dc8af6243e5c9a2b36da77b1c59bde968b1b139e7ccb742f5ac626` |
| `git diff --name-status 7750c9b... f3b6449...` and remediation-commit stat | Only the prior report plus the seven declared remediation paths; remediation commit itself changes exactly seven paths |
| Dependency-blob equality check across original and remediation commits | Exit 0; `src/security`, `errors.ts`, `exact.ts`, and `postgres-readiness.ts` are byte-identical trees/blobs |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`, pinned Node/package manager/build policy and local `tsx`/`zod` resolution confirmed |
| In-memory exact-original-module caller-direction replay | Exit 0; both unrelated digest/time cases accepted with preparation true and live authority false; `AUTO110-IR-001` reproduced |
| Current builder/parser owner-direction hostile probe | Exit 0; 4 builder extras and 9 fully re-digested parser forks rejected; direction getter/trap counts both 0 |
| Current lineage/blocker/capability/projection hostile probe | Exit 0; 53 authority forks and 6 lineage forks rejected; 36 exact unique blockers; blocker getter/trap counts 0; exact 23-field projection |
| `node --import tsx --test tests/operations-postgres-rehearsal.test.ts` | 13/13 passed; zero failures, skips, cancellations, or todos |
| `npm run test:cr11b` | 183/183 passed; zero failures, skips, cancellations, or todos |
| `npm run check` | Exit 0; TypeScript check passed |
| `git diff --check` | Exit 0 before and after the report write; no whitespace errors |
| `git diff --check 7750c9b...f3b6449` and `git diff --check f3b6449^..f3b6449` | Exit 0; original-to-remediation and exact remediation-commit ranges have no whitespace errors |

The first historical replay attempt was corrected after Node refused to resolve bare `zod` from a `data:` module; the
successful replay explicitly mapped the locally resolved dependency URL. The first current probe's security assertions
completed, but its final diagnostic digest calculation retained an `undefined` field and exited 1; deleting the digest
field canonically fixed the reviewer probe, which then exited 0 with the results above. Neither reviewer-harness
correction changed the repository or exposed a candidate failure.

No GitHub or other network query was made because this review explicitly prohibited external contact. Local refs,
history, frozen objects, source, and tests supplied all review evidence.

## Findings

### `AUTO110-IR-001` — closed

The original attack is no longer possible through either public construction or serialized parsing. Exact snapshot
equality, not caller-selected digest syntax, is now required before `phasePreparationAuthorized: true` can survive. The
accepted snapshot explicitly grants no live, protected-reference, or host-contact authority.

### New findings

None.

## Sanitized negative authority

The remediation and this re-review performed no provider, host, protected-reference, network, process, PostgreSQL
service, database, credential, service-control, configuration, migration, backup, restore, cleanup, consumer,
deployment, DNS, Cloudflare, or external-system contact or change. No native rehearsal or live qualification occurred.
No raw host identity, protected locator, credential reference/value, connection string, production data, raw evidence,
or deployable configuration was read or retained. No commit, push, approval, or merge occurred.

All 36 live production blockers remain exact and blocking. This report grants no approval, owner effect window,
protected-reference resolution, host/database contact, installation, service control, migration, backup/restore,
cleanup, consumer activation, deployment, retry, dispatch, execution, or external-effect authority.

## Final verdict

Exact remediation commit `f3b64498c2313c86d50f63e4c62cf7c7eba5fcd6`, tree
`d2ab467adf2032504f31a0b6d1c852f77a3ddf58`, closes `AUTO110-IR-001` and is accepted only as the frozen effect-free
repository snapshot. A later live PostgreSQL rehearsal remains separately blocked by all 36 live gates and a fresh exact
strong-factor owner effect window.

`ACCEPTED_EFFECT_FREE_REPOSITORY_SNAPSHOT`

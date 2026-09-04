# CR13A-LIVE-490 independent product review

**Disposition:** ACCEPTED for ordinary integration of the inert contract only

**Review type:** different independent report-only remediation re-review

**Findings:** High 0; Medium 0; Low 0

**Accepted product commit:** `dc313b1f2ff5982fe0ffa3b505db36025036601f`

**Accepted product tree:** `de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3`

**Rejected product commit:** `77aa5108868474495d8786fbb77e47fe338448db`

**Accepted product parent:** `77aa5108868474495d8786fbb77e47fe338448db`

**Contract SHA-256:** `2f0e3544940160fbdf90c45d3ca0332220f62334202c0d0fab96f13682b6332d`

**Focused test SHA-256:** `8696f4279808a62209376b2748010d8b32aeb436d48b26cc0dfa3ce3670953d1`

## First review and remediation

The first independent reviewer rejected exact product `77aa5108868474495d8786fbb77e47fe338448db`, tree
`3cd2e4d2641caf59c841bb716787f8abc07d69ee`, with 3 High, 2 Medium, and 0 Low findings:

- H-001: root-rotation signatures were circularly included in the body they were meant to sign, and the registry's
  owner-root/trust-registry signer participation was ambiguous;
- H-002: a second active key revision was permitted during a claimed overlap, but no exact signed overlap declaration
  or monotonic/no-reactivation rule existed;
- H-003: five anchor names did not bind five distinct adapter products, writer keys, streams, destinations, and
  custody domains;
- M-001: the anchor receipt's settlement value and revision/head/deadline consequences were open; and
- M-002: the transitive audit missed re-exports and legacy loaders and did not freeze each resolved module's exact
  export, top-level call, or constructor surface.

The remediation separates the signature-free canonical root-rotation body from a dual-signature envelope. Both root
signatures repeat one canonical body digest and their exact root identities. Trust-registry genesis requires the
out-of-band root; every later registry revision requires the root plus the trust-registry signer; and a manifest
requires the deployment-manifest signer. Missing, reordered, or digest-divergent signature-policy substitutions are
rejected by the exact singleton boundary.

Each rotation overlap now declares the role, prior and successor entry digests/revisions, canonical interval,
authorizing registry sequence, and dependent manifest transition. The schema requires both registry signers plus the
manifest signer, strictly increasing revisions, at most 300 seconds, no overlapping declarations, no replay, and no
lower-revision reactivation. The signed registry body carries the ordered declarations, while the dependent manifest
selects exactly one active revision.

The ordered five-anchor binding schema maps each role to its exact accepted adapter component, writer-key role,
stream domain, adapter/key binding digests, protected destination, and custody domain. All eight dimensions are
pairwise distinct; sharing and cross-role adoption are forbidden.

Only `desired_state_adopted`, `proven_expected_state_unchanged`, and `proven_authenticated_conflict` are valid anchor
receipt settlements. Exact request/body, expected/desired/observed/settled revision and head, authentication, and
exclusive deadline invariants apply. Timeout, malformed, or unknown outcomes have no receipt and quarantine.

The graph gate now follows imports, re-exports, and import-equals dependencies; rejects dynamic imports,
`require`, and `createRequire`; and independently fixes every resolved module's ordered exports and allowed
module-level calls and constructors. A new exported signer, store, resolver, reader, writer, CAS adapter, dependency
factory, loader, or effectful module therefore fails the producer gate.

The different independent reviewer closed H-001, H-002, H-003, M-001, and M-002 and reported no new finding.

## Other review results

The contract still binds exact accepted LIVE-480 product `6d510d6f1b80a98c00c16fcf2b55837afc1cea87`, tree
`ac8655e1240d25bea9150ae9678f6ad5df56593c`, review SHA-256 `854d3688...`, and acceptance SHA-256 `5f549c3f...`.
It reuses the exact accepted 42-component and 28-key-role schemas by identity.

Singleton provenance, hostile accessor/proxy/Symbol non-execution, captured-intrinsic resistance, deep freezing,
sanitization, and safe consumer isolation pass. The status retains 44 zero actual totals, eight false grants, and no
blocker, qualification, candidate, activation, runtime, or deployment clearance.

No root, key, registry, manifest, anchor, signer, verifier, store, migration, database, native, network, runtime, or
deployment implementation exists in this block.

## Verification

- focused LIVE-490 suite: 15/15 passed independently;
- combined CR13A command: LIVE-490 pretest 15/15 plus existing CR13A 473/473 passed independently;
- TypeScript and full lint: passed independently;
- complete repository lifecycle: 769/421/392 passed by the producer;
- production build: all five phases passed independently;
- rendered routes: 4/4 passed independently;
- migration verification: migrations 0001-0038 and 124 tables passed independently using only the disposable local
  verifier database;
- macOS stage zero: `ready_for_runtime_check`; no runtime/native check invoked; and
- `git diff --check`: passed independently.

The ordinary sandbox denied only the migration verifier's temporary local `tsx` IPC pipe. Its authorized local-only
rerun passed without production database or network contact.

## Effects and authority

Both reviewers were report-only. They created no file, commit, or branch change and performed no network, native
provider, credential/key, protected-value, production-database, deployment, DNS, hosting, or external effect.
Acceptance covers only ordinary integration of inert vocabulary and singleton parsers. It grants no issuer, signer,
key, registry, manifest, anchor, store, migration, recovery effect, capsule, provider/source, IPC/process, native,
runtime, deployment, hosting, or DNS authority.

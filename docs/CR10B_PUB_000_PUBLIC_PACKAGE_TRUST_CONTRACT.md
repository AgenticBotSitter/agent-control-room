# CR10B-PUB-000 public package trust contract

**Status:** Accepted locally for the exact metadata-only, build-disabled, signing-disabled, publication-disabled boundary.
**Contract:** `control-room-public-package/v1`
**Format:** `control-room-public-package-format/v1`
**Implementation:** `src/public-package/v1/contract.ts`

## Purpose

This block defines what a future public Control Room package may claim before any public tree is assembled. It does not decide that the current repository is safe to publish. It does not read repository content, construct an archive, resolve a registry, handle a signing key, install a package, or contact a provider.

The contract separates five facts that must not be collapsed:

1. a logical file was explicitly classified for one public package surface;
2. a canonical manifest binds exact metadata and digests;
3. compatibility evaluation accepted one exact version request;
4. an external verifier reported a signature result;
5. all required release evidence was reported and remains fresh.

Even when all five are reported, the output is only a candidate for independent release review. It is always `not_certified`, requires a fresh owner release decision, and grants no installation or publication authority.

## Default-private classification

Unclassified material is private. A path alone never makes content public. The v1 registry admits exactly eight public classes:

| Class | Only permitted logical root | Additional limit |
|---|---|---|
| `public:core` | `packages/control-room-core/` | Core contract source only |
| `public:adapter-sdk` | `packages/control-room-adapter-sdk/` | Observation-only SDK |
| `public:conformance-kit` | `packages/control-room-conformance-kit/` | Effect-free synthetic conformance |
| `public:reference-adapter` | `packages/reference-adapters/` | Synthetic reference adapters |
| `public:synthetic-example` | `examples/synthetic/` | Synthetic identities and data only |
| `public:documentation` | `docs/public/` | Deliberately public documentation |
| `public:schema` | `schemas/public/` | Public machine contracts |
| `public:release-metadata` | `release/` | Release trust metadata |

The registry explicitly denies nine private classes: deployment configuration, credential material, host identity, production history, private artifact bodies, broker state, owner trust, internal review, and runtime state.

Every class forbids raw runtime values, credential values, private locator values, production history, executable effects, and authority. Private classes have no allowed public root. The registry is default-deny and records that the contract itself did not inspect content.

## Canonical entry rules

A manifest entry is metadata for one regular, non-executable file. V1 rejects:

- absolute paths, traversal, empty segments, alternate separators, percent encodings, or non-NFC text;
- `.git`, `.env`, `.ssh`, `.gnupg`, `.codex`, `.agents`, and `node_modules` segments;
- key-container, private-key, and local-database suffixes;
- a class whose declared public root does not contain the entry;
- duplicate paths, case-fold aliases, reordered manifests, symlinks, and executable entries; and
- accessors, Proxies, extra keys, non-JSON values, secret-like values, and unbounded structures.

Each entry binds its logical path, class, kind, media type, size, content digest, source digest, and entry digest. The manifest binds the ordered entry-digest set.

## Immutable manifest

One manifest binds:

- package and format version;
- exact public classification and compatibility policy revisions;
- the full supported-contract set;
- ordered entry metadata and entry-set digest;
- source revision, build recipe, and dependency lock digests;
- SBOM, license inventory, NOTICE, provenance, private-tree scan, credential scan, and reproducibility-plan digests; and
- an explicit declaration that runtime values, credentials, private locators, production history, signatures, and certification claims are absent.

The contract consumes metadata supplied by a later package builder. It does not inspect bytes, and a SHA-256 digest is not a signature or trust decision.

## Version and compatibility policy

V1 accepts only strict semantic versions in the supported `0.1.x` release line and these exact contract identifiers:

- `control-room-domain/v1`
- `control-room-harness-adapter-sdk/v1`
- `control-room-harness-event/v1`
- `control-room-harness/v1`
- `control-room-package-registry/v1`
- `control-room-project-workspace/v1`
- `control-room-public-package-format/v1`

Wildcards, unknown contracts, prereleases, format substitution, package/manifest mismatch, unsupported release lines, and downgrades fail closed. Security maintenance means the latest patch in every supported line. A breaking change requires a new major version, or a new minor version while the project is pre-1.0. The actual support promise comes from a separately published supported-versions document; this repository contract cannot create that public promise by itself.

## Signature claim separation

An unsigned manifest and an unverified signature-digest claim are distinct states. The claim contains only digests and reports all of the following as false:

- signature bytes present;
- signing-key value present;
- cryptographic verification performed;
- certification granted; and
- publication authority granted.

A separate verification record may report `not_observed`, `failed`, or `verified_external`. A passing external report must bind the exact manifest and claim and come from a verifier distinct from the manifest producer. The contract stores no signature bytes or key value and performs no cryptographic operation. Downstream wording must remain “external signature verification reported,” not an unconditional statement that Control Room verified the signature.

## Release evidence gates

Evidence is fixed to eleven ordered gates:

1. manifest integrity;
2. explicit public classification;
3. private-tree exclusion;
4. credential-value exclusion;
5. complete SBOM;
6. complete license inventory and NOTICE;
7. complete provenance;
8. reproducible build;
9. compatibility pass;
10. adapter conformance; and
11. clean-room installation.

Classification, private-tree, credential, adapter-conformance, and clean-room evidence require an independent verifier. Gate evidence is fresh for at most seven days. Manifest, classification, private-tree, credential, SBOM, license/NOTICE, and provenance gates bind exact manifest evidence digests. The remaining gates bind separately produced evidence because a plan digest cannot prove that a reproducible build, compatibility check, conformance run, or clean-room install actually occurred.

Evidence mode is either:

- `synthetic`, which can produce only `synthetic_candidate_only`; or
- `external_digest_only`, which records external evidence references without claiming the contract executed those checks.

Missing, failed, stale, reordered, foreign-package, foreign-policy, or substituted evidence blocks.

## Certification and publication boundary

The release assessment has only three states:

- `blocked`;
- `synthetic_candidate_only`; or
- `candidate_for_independent_release_review`.

No state is certified. No state authorizes build, signing, installation, upload, or publication. A future certification requires the CR10Q independent security and privacy review, clean-room evidence, supported-versions and disclosure decisions, real protected signing resources, and a fresh owner release decision.

The disabled publisher has no provider client, registry destination, credential reference, network path, builder, signer, or uploader. It always returns `disabled_before_provider_contact` with safe reason `public_release_not_authorized`.

## Safe projection

The owner projection shows package/version, candidate state, blocker codes, entry/class counts, compatibility status, the external signature report status, certification eligibility, and evidence mode. It omits entry paths, evidence references, private values, credential values, destinations, and controls. Publication and signing are visibly unavailable.

## Explicitly not proved

This block does not prove that any current repository file is public-safe, that the future split packages compile, that dependencies are licensed, that an SBOM is complete, that builds are reproducible, that a signature is cryptographically valid, that public instructions install cleanly, or that a release should occur. Those claims belong to CR10B-PUB-010 through PUB-080, CR10C, and CR10Q.

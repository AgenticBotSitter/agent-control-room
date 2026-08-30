# CR10B-PUB-000 acceptance

**Disposition:** Accepted locally for the exact metadata-only, effect-free boundary on 2026-08-29.
**Publication disposition:** Disabled.
**Certification disposition:** Not certified.
**External effects:** None.

## Delivered

- default-private registry with eight exact public and nine exact private classes;
- strict class-root and canonical logical-path enforcement;
- immutable entry and package manifests with source, lock, SBOM, license/NOTICE, provenance, scan, and reproducibility bindings;
- exact supported-contract and `0.1.x` release-line policy;
- deterministic compatibility request and assessment with downgrade resistance;
- unsigned and unverified signature claims separated from external verification reports;
- eleven ordered, freshness-bounded release gates with required verifier independence;
- synthetic-only, blocked, and independent-review candidate dispositions;
- permanently `not_certified`, non-authorizing candidate semantics;
- safe owner projection with no paths or evidence references; and
- disabled publisher with no filesystem, process, signing, registry, credential, or network client.

## Focused hostile evidence

`tests/public-package-contract.test.ts` passes 21/21 cases covering:

- default-private classification and semantic registry drift;
- canonical manifest ordering and metadata-only authority separation;
- private classes, traversal, local state, wrong roots, and case-fold aliases;
- compatibility-policy drift, downgrade, format mismatch, prerelease, unsupported line, and unknown contract;
- signature-claim/verification separation, self-verification, and cross-package binding;
- fixed gate order, independent verification, and evidence freshness;
- cross-package evidence substitution and reordered evidence bundles;
- external evidence limited to an independent-review candidate;
- synthetic evidence limited to a synthetic candidate;
- failed, absent, unsigned, and expired evidence blocking;
- signature/manifest aliasing and certification overclaim prevention;
- safe projection leakage checks;
- disabled publication before every consequential boundary; and
- secret-like values, accessors, Proxies, and forbidden runtime imports.

## Acceptance conditions

| Condition | Result |
|---|---|
| Unclassified and private material cannot enter the manifest | Pass |
| Manifest is canonical, ordered, digest-bound, and authority-free | Pass |
| Compatibility is exact and downgrade-resistant | Pass |
| Signature claim does not masquerade as verification | Pass |
| External verification does not masquerade as certification | Pass |
| Synthetic evidence cannot become release-ready | Pass |
| Missing, stale, foreign, reordered, or substituted evidence blocks | Pass |
| Candidate always remains not certified and non-authorizing | Pass |
| Projection omits paths, evidence references, and private values | Pass |
| Publisher has no effect client and attempts nothing | Pass |

## Complete repository gate

- focused CR10B suite: 21/21 passed;
- registered repository pretest: 515/515 passed;
- main suite: 416 total, 414 passed, zero failed, two intentional platform skips;
- TypeScript check: passed;
- full ESLint: passed;
- production build: passed;
- rendered route verification: 2/2 passed;
- migrations: 0026 applied, 96 PostgreSQL tables verified; and
- whitespace/diff validation: passed.

## Stop boundary

No public tree or package was built. No repository content was classified as actually safe. No signing key, signature bytes, credential, destination, registry, provider, filesystem tree, process, archive, install, upload, network connection, or publication was used. No commit or push was created under the owner’s local-only instruction.

## Next

CR10B-PUB-010/020/030/040 may now implement the public core, observation-only adapter SDK package, conformance kit, and synthetic reference adapters inside the frozen roots. Those packages remain private local candidates until the later mechanical scans, independent review, clean-room proof, and owner release gate pass.

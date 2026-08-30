# CR10C-MECH-050 — Public-tree disposition

**Status:** complete locally with a blocked, non-authorizing disposition

## Decision

The current public-package tree is a mechanically checked candidate, not an approved public release. The disposition is:

- `state`: `blocked_before_independent_review`
- `licenseDisposition`: `unresolved_owner_authority_and_complete_text_required`
- `publicTreeDisposition`: `mechanical_candidate_not_approved_for_public_release`
- `nextRequiredBlock`: `CR10Q-SEC-000/010`

This is intentionally a blocked result. It preserves the useful CR10C mechanical evidence without treating a green local scan as legal authority, independent security evidence, a clean-room installation, or permission to publish.

## Evidence evaluated

The disposition consumes the exact CR10C-MECH-010/020/030/040 mechanical audit and adds narrow local observations:

- all eight frozen public roots and all 36 regular files remain in the digest-bound mechanical inventory;
- all five candidate packages have an 11-byte `Apache-2.0` identifier file, but none contains the complete Apache License 2.0 text;
- none of the five candidate package manifests declares a license;
- the prepared local dependency tree identifies `zod@4.1.12`, its manifest declares MIT, its local MIT text is present, and the lock entry is bound to the observation;
- the Zod observation is local prepared-workspace evidence, not independent provenance; and
- no owner licensing-authority record, attribution review, final artifact inventory, signature verification, real clean-room installation, independent privacy review, independent security review, or owner publication decision was observed.

The public projection contains only state counts and blocker codes. It contains no candidate paths, evidence digests, license body, private value, or release credential.

The 36-file count is derived from the exact audit inventory. CR10Q-SEC-020 corrected the earlier 37-file prose mismatch reported as `CR10Q-IR-003`; the original independent report remains unchanged.

## Gate result

The exact 17-gate disposition records:

- 6 `passed_local` gates: current mechanical audit, fixed-root inventory, identifier files, local direct-dependency metadata, schema/fixture/link normalization, and bounded private-data scan;
- 2 `failed` gates: complete project license text and package-manifest license metadata; and
- 9 `not_observed` gates: author licensing authority, independent dependency provenance, NOTICE attribution review, independent private-data review, final artifact inventory, signature verification, real clean-room installation, independent security review, and owner publication decision.

All 11 failed or unobserved gates remain blockers. A later reviewer may add evidence, but must not rewrite an unobserved or failed gate as passed without evidence bound to the exact candidate.

## Legal and release boundary

This disposition does not provide legal advice, infer that the author granted a license, or choose a project license. Adding a complete license text or manifest declaration would be a material licensing decision and requires confirmed owner authority and, where appropriate, legal review.

The implementation has no archive builder, package installer, registry or network client, signer, uploader, publisher, provider, native harness, or enabled release effect. It cannot certify the tree, create an artifact, change repository visibility, or publish a package.

## Local commands

```text
npm run public:tree-disposition
npm run test:cr10c-disposition
```

The command reads only the fixed candidate files, prepared local Zod evidence, and the lockfile. It prints the safe projection to standard output and writes nothing.

## Next block

CR10Q-SEC-000/010 must perform the Codex-owned threat, privacy, recovery, and public-boundary review and then obtain a genuinely independent execution of the frozen review packet. The independent reviewer is evidence authority for its own review only; it cannot grant a license, approve publication, or satisfy owner-only release gates.

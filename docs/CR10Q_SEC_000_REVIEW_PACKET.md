# CR10Q-SEC-000 — Frozen public-release security review packet

**Status:** historical packet executed; independent disposition was `remediation_required`
**Packet contract:** `control-room-public-security-review-packet/v1`
**Reviewed packet:** `public-security-review:6fc96618cf696e2b0ea82cf8`
**Required next block:** `CR10Q-SEC-020/025`

## Independent reviewer assignment

The reviewer must be different from the candidate producer and the CR10Q architect/remediation author. The reviewer may inspect the complete local repository and run effect-free repository tests. The only permitted source-tree write is the independent report at `docs/reviews/CR10Q_INDEPENDENT_REVIEW.md`. Do not repair source, change tests, change licenses, add dependencies, install packages, contact a registry or provider, use credentials, invoke a native harness, sign, upload, publish, deploy, or perform any external effect.

The owner authorized CR10Q-SEC-010 and a different independent reviewer completed it. `docs/reviews/CR10Q_INDEPENDENT_REVIEW.md` records `remediation_required`. Do not reuse this historical packet to accept the changed candidate; CR10Q-SEC-025 must use the separately bound remediation re-review packet and another different reviewer.

## Frozen candidate and enforcement scope

Review the exact 36-file mechanical candidate under these eight roots:

This count was corrected under `CR10Q-IR-003` after independent execution found that the machine-bound inventory contained 36 files while this sentence said 37. The original reviewed packet identity and independent report preserve the historical mismatch as evidence.

- `packages/control-room-core/`
- `packages/control-room-adapter-sdk/`
- `packages/control-room-conformance-kit/`
- `packages/reference-adapters/`
- `examples/synthetic/`
- `docs/public/`
- `schemas/public/`
- `release/`

Also review the private enforcement and evidence sources that decide whether that candidate may advance:

- `src/public-package/v1/contract.ts`
- `src/public-package/v1/package-layout.ts`
- `src/public-package/v1/release-tooling.ts`
- `src/public-package/v1/mechanical-assurance.ts`
- `src/public-package/v1/public-tree-disposition.ts`
- `src/public-package/v1/security-review-packet.ts`
- `scripts/public-package-synthetic-clean-room.ts`
- `scripts/public-package-mechanical-audit.ts`
- `scripts/public-tree-disposition.ts`
- `scripts/public-security-review-packet.ts`
- every `tests/public-*.test.ts` file and `tests/proxy-test-helper.ts`

Recreate the packet with `npm run public:security-review-packet`. The packet identity, source inventory, disposition, regression source, ordered case set, and architect finding set must remain exact. If any reviewed input changes, stop and report candidate drift rather than reviewing a different tree under this packet ID.

## Required 24-case attack matrix

| # | Case | Required determination |
|---:|---|---|
| 1 | `classification.default_private` | Unclassified/private content cannot become public by path placement or caller assertion |
| 2 | `path.traversal_absolute_encoding` | Absolute, traversal, alternate-separator, and encoded paths fail |
| 3 | `path.case_unicode_alias` | Case-fold and Unicode aliases cannot create a second logical file |
| 4 | `tree.symlink_special_executable` | Symlinks, special entries, and executable inputs block |
| 5 | `tree.private_identity_history` | Internal identity/history findings remain digest-only and block |
| 6 | `tree.credential_secret_locator` | Credentials, keys, tokens, signed URLs, and private locators remain digest-only and block |
| 7 | `data.proxy_accessor_symbol` | Proxy, accessor, and symbol boundaries reject before caller behavior executes |
| 8 | `data.prototype_sparse_cycle_size` | Custom prototypes, sparse arrays, cycles, non-finite values, and oversized structures reject before adapter invocation |
| 9 | `adapter.hidden_mutable_method` | Hidden, added, mutable, inherited, or accessor-backed adapter members reject |
| 10 | `adapter.caller_code_not_sandboxed` | Documentation and results never claim the validator sandboxes caller code; untrusted code retains an isolation blocker |
| 11 | `adapter.compatibility_result_spoof` | Hostile or semantically invalid compatibility output cannot pass |
| 12 | `adapter.normalization_binding_replay` | Events bind exact tenant, run, sequence, time, schema, source, and unique source key |
| 13 | `adapter.resource_exhaustion` | Data and case processing remain bounded or the reviewer records a blocker |
| 14 | `dependency.complete_sbom_provenance` | Local metadata cannot satisfy independent SBOM/provenance evidence |
| 15 | `license.text_notice_authority` | Identifier stubs and missing manifest metadata remain failures; no license grant is inferred |
| 16 | `artifact.inventory_toc_tou` | Mechanical source inventory cannot masquerade as a final immutable artifact inventory |
| 17 | `build.reproducibility_substitution` | Synthetic reproduction cannot satisfy independent build evidence |
| 18 | `signature.key_manifest_provenance` | Digest claims cannot masquerade as signature/key/provenance verification |
| 19 | `install.real_clean_room` | Prepared-workspace tests cannot satisfy a real clean-room installation |
| 20 | `disclosure.private_reporting_channel` | Missing protected disclosure resources remain an owner blocker; no private address is committed |
| 21 | `release.rollback_revocation` | No release advances without exact rollback/revocation preparation |
| 22 | `evidence.replay_reorder_substitution` | Replayed, reordered, foreign, stale, or re-digested evidence fails closed |
| 23 | `recovery.failure_cleanup_ambiguity` | Failure and uncertainty preserve ambiguity without blind retry or success claims |
| 24 | `owner.publication_authority` | Reviewer evidence never becomes the owner publication decision |

## Architect findings to re-attack

| ID | Severity | Producer remediation claim to verify independently |
|---|---:|---|
| `CR10Q-AF-001` | High | Core data, adapter definition, conformance input/fixture/decision/output, and case boundaries now reject Proxies and accessors without executing traps/getters; ordinary data is bounded, copied, and immutable |
| `CR10Q-AF-002` | High | Adapter functions are captured from an exact public shape; hidden/mutable method substitution rejects; documentation now says clearly that caller-supplied adapter code executes in the caller process and is not sandboxed |

Do not accept the producer tests alone. Construct independent hostile values and confirm trap/getter counts, adapter call counts, immutable results, exact failure reasons, and absence of release authority.

## Required verification

Run from the already-prepared repository without installing or downloading anything:

```text
npm run public:mechanical-audit
npm run public:tree-disposition
npm run public:security-review-packet
npm run test:cr10b
npm run test:cr10c
npm run test:cr10c-disposition
npm run test:cr10q
npm test
npm run check
npm run lint
npm run build
node --test tests/rendered-html.test.mjs
npm run db:verify
git diff --check
```

The independent report must give commands and counts, each case disposition, each architect finding disposition, new findings with evidence and severity, residual blockers, scope/identity drift checks, and one final result:

- `remediation_required`; or
- `accepted_effect_free_repository_snapshot_with_release_blockers`.

Even an accepted independent result does not resolve licensing authority, complete license text, package-manifest license metadata, NOTICE review, dependency provenance, final artifact inventory, signature verification, real clean-room installation, disclosure resources, signing resources, repository visibility, or owner publication approval.

Never copy a detected private value into the report. Use only the safe path, detector kind, and digest when a bounded scanner produces a finding; if the reviewer discovers a value outside that format, record only a neutral blocker and notify the owner privately.

# CR10C-MECH-010/020/030/040 — Public candidate mechanical assurance

**Status:** complete locally as digest-only, non-authorizing evidence

## Delivered

- `src/public-package/v1/mechanical-assurance.ts` defines a strict, digest-bound audit contract for only the eight frozen public roots.
- `scripts/public-package-mechanical-audit.ts` reads only those roots, rejects symlinks and special filesystem entries, and emits one deterministic JSON report without retaining file bodies.
- The report inventories 36 regular files, five local package candidates, their declared direct dependencies, and exact LICENSE/NOTICE file digests.
- It normalizes the two public JSON schemas, two fabricated fixtures, and five local Markdown links.
- The private-data scanner recognizes credential assignments, private-key blocks, bearer tokens, signed URLs, and resolved private locators. Findings retain only safe path, kind, and digest.
- `tests/public-package-mechanical-assurance.test.ts` exercises normal operation plus path, dependency, link, content, digest, and Proxy-substitution failures.

## What the audit proves

The audit is a bounded mechanical observation of the current local candidate tree. It proves that the fixed inputs had the exact observed digests, that the five candidate manifests match their narrow dependency graph, that each candidate contains LICENSE and NOTICE files, that the two schemas preserve their no-effect constants, and that the bounded scan returned no finding for the inspected snapshot.

It does not decide whether any license is legally acceptable, whether every transitive dependency is complete or acceptable, whether an inspection is an independent security review, whether the tree is safe to make public, or whether any package may be installed, archived, signed, or published.

## Safety boundary

The script has no caller-selected path, no write behavior, no archive builder, package manager, subprocess, registry, network, signer, provider, native harness, or publication client. It reports public candidate paths and digests only; no file text or candidate body is stored in the resulting evidence. The current successful result is only `mechanical_candidate_only`.

## Re-run locally

```text
npm run public:mechanical-audit
npm run test:cr10c
```

The report is intentionally printed, not written to a release directory or transmitted. A sensitive-data finding must remain a blocked result until a later owner-controlled investigation; do not paste a detected value into an issue, pull request, test, or status report.

The 36-file count is the machine-produced inventory. Earlier prose said 37; `CR10Q-IR-003` identified that mismatch, and CR10Q-SEC-020 corrected the human-readable count without changing the independent report.

## Remaining decision

CR10C-MECH-050 is the Codex-owned disposition: review the evidence, set a conservative license/public-tree decision, and leave every release effect disabled. It is not delegated to the audit and is not a publication decision.

# CR10Q architect public-package security review

**Date:** 2026-08-29
**Mode:** Codex architect adversarial review and remediation
**Status:** initial independent review complete with remediation required; architect remediation complete pending different independent re-review
**Effects:** none

## Disposition

The architect pass found two high-severity public-boundary defects and repaired both locally. A different independent reviewer executed the exact 24-case packet `public-security-review:6fc96618cf696e2b0ea82cf8` and returned `remediation_required`. That report is preserved byte-for-byte. CR10Q-SEC-020 repairs its two high runtime findings and one medium scope-count finding, but those repairs remain producer claims until a different re-reviewer accepts them. The candidate remains blocked and is not a public release candidate.

## Findings and remediation

| ID | Severity | Finding | Remediation and producer regression |
|---|---:|---|---|
| `CR10Q-AF-001` | High | Public digest, redaction, freezing, adapter definition, fixture, compatibility-result, normalization-result, and conformance-case boundaries could inspect Proxy/accessor-backed objects. Direct property reads, spread, iteration, and generic cloning could execute caller behavior or normalize an attacker-controlled shape. | Added one bounded ordinary-data snapshot in the public core; it rejects Proxies, accessors, symbols, sparse arrays, custom prototypes, cycles, non-finite numbers, excessive depth/nodes/keys/string size, and invalid descriptors before behavior. Adapter, input, fixture, decision, output, and case collectors capture exact ordinary data properties and function references. Eight focused hostile tests prove zero Proxy traps/getters and immutable valid results. |
| `CR10Q-AF-002` | High | The conformance kit and public security text said or implied the conformance path was effect-free even though it directly invokes caller-supplied JavaScript adapter functions. Exact method names do not sandbox arbitrary code. | Adapter shape remains observation-only, exact, and immutable, but code comments and public documentation now state that the validator is not a sandbox. Untrusted third-party adapter code requires a separate process/OS boundary with no credentials, private files, provider access, or network authority. The frozen review packet requires an independent reviewer to re-attack hidden/mutable methods and the corrected isolation claim. |

## Architect regression result

- boundary-remediation suite: 8/8 passed;
- frozen packet suite: 6/6 passed;
- combined CR10Q focused gate: 14/14 passed;
- mechanical audit after remediation: 36 files, 5 components, 2 schemas, 2 fabricated fixtures, 5 local links, zero bounded private-data findings;
- public-tree disposition after remediation: 6 local passes, 2 failures, 9 unobserved gates; still blocked; and
- packet projection: 24 cases, 15 critical, 9 high, 2 pending architect findings, no independent result, no release candidate, no effects.

Complete repository verification is recorded in `BUILD_STATUS.md` after the final regression pass.

## Independent findings and CR10Q-SEC-020 remediation

| ID | Severity | Independent finding | Architect remediation and regression claim |
|---|---:|---|---|
| `CR10Q-IR-001` | High | An own reserved prototype-mutating property could become inherited state in a copied record, escape own-key scanning, and let compatibility logic observe evidence that was not preserved as an own property. | Ordinary-data records are created with a null prototype, reserved names `__proto__`, `constructor`, and `prototype` are rejected before nested values are visited, and properties are defined rather than assigned. Regression coverage proves all four public data operations reject with zero nested Proxy traps and conformance rejects before the compatibility callback is invoked. |
| `CR10Q-IR-002` | High | Property values were bounded, but property-name length was not. | Public data property names now have a 256-character ceiling. Regression coverage proves the exact ceiling is accepted, a 257-character name is rejected by all four public data operations, and accepted snapshots retain null-prototype own state. |
| `CR10Q-IR-003` | Medium | Human review documents claimed 37 candidate files while the machine-bound inventory contained 36. | Current mechanical-assurance, disposition, packet, architect-review, and build-status claims now say 36. The independent report remains unchanged and its digest is bound into the remediation re-review packet. |

CR10Q-SEC-020 also adds a strict remediation re-review contract. It binds the unchanged negative report digest, the original reviewed packet, the remediated candidate packet and source inventory, code and regression digests, corrected-scope document digest, all three findings, and all 24 original cases. It requires a reviewer different from the original reviewer, architect, and producer; permits only a report; and grants no legal, licensing, release, publication, or external-effect authority.

The CR10Q focused gate now passes 22/22: 11 public-boundary tests, 6 original-packet tests, and 5 remediation-packet tests. These are producer regressions, not independent acceptance.

## Retained blockers

The five project candidates still contain only 11-byte `Apache-2.0` identifier stubs and no package-manifest license declaration. Owner licensing authority, complete license text, NOTICE attribution review, independent dependency provenance, final artifact inventory, signature verification, real clean-room installation, protected disclosure/signing resources, repository visibility, and owner publication decision remain unresolved.

The conformance kit validates output from trusted adapter code; it does not make arbitrary adapter code safe. A future product feature for third-party adapter execution requires its own isolated executor, capability, resource, credential, egress, cleanup, and independent security contract.

## Next

CR10Q-SEC-025 requires explicit owner authorization for a reviewer different from the original reviewer, architect, and candidate producer. That reviewer must execute the remediation re-review packet, re-run all 24 original cases, independently challenge all three remediations, and write only the new remediation re-review report.

# CR13A-LIVE-050 independent provider-disabled ingress security and integrity review

**Disposition:** `rejected`

## Review identity and scope

- Immutable base: `34379984d3c4793f2c2d464ffb3545ab98717ba5`
- Immutable product target: `b86e60e5f8389029030deaaada890267e5f92f53`
- The fresh independent Codex reviewer was different from the producer and prior CR13A reviewers.
- Review mode was read-only, report-only, with zero repair budget.
- Producer tests and documentation were treated as claims to attack.
- Product commands ran from a disposable exact-target archive using the repository's prepared dependencies.
- Runtime: Node `v22.22.3`, pnpm `11.19.0`.

## Deterministic reproduction

Every packet-required command completed successfully:

- Stage zero: exit `0`, status `ready_for_runtime_check`, lockfile SHA-256
  `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`.
- TypeScript `--noEmit`: exit `0`, no diagnostics.
- Full ESLint: exit `0`, no diagnostics.
- Intake, delivery, and ingress tests: exit `0`, `20/20` passed with no failures or skips.
- Complete connection slice: exit `0`, `35/35` passed with no failures or skips.
- Migration verification: exit `0`; migrations `0001` through `0036` applied and `119 PostgreSQL tables` verified.
- Exact `git diff --check`: exit `0`, no output.

These passing commands do not close the independent finding below.

## Findings

### High

None.

### Medium

#### M-001 — Post-import ambient mutation executes and bypasses ingress-receipt drift detection

**Evidence**

- `src/connection-registry/v1/node-ingress.ts:106-142` presents
  `parseConnectionEnrollmentNodeIngressReceiptV1()` as the strict integrity parser.
- Digest validation at `src/connection-registry/v1/node-ingress.ts:137` calls the shared `sha256Digest()` without an ingress
  runtime-integrity guard.
- `src/security/digest.ts:33-52,61-62` dynamically resolves ambient `Object.keys`, array `sort`, `map`, and `join`,
  `JSON.stringify`, and related operations after import.
- The accepted outer delivery boundary has a selected-runtime guard, but that guard does not protect direct ingress
  receipt parsing or mutations introduced after the coordinator's awaited intake seam.
- The producer drift test covers an honest runtime only.

**Reproduction**

An independent no-write probe:

1. Constructed a valid revision-1 ingress receipt and digest.
2. Changed `registryRevision` to `2` without changing the digest.
3. Confirmed the ordinary parser rejected it as `integrity_failed`.
4. Replaced `Object.keys` after module import. When the replacement received the parser's temporary unsigned revision-2
   object, it changed only that temporary object back to revision `1` and delegated to the original operation.
5. The replacement executed once. The parser accepted and returned the revision-2 receipt under the unchanged revision-1
   digest.

Observed output:

```json
{
  "baseline": "integrity_failed",
  "mutated": {
    "outcome": "accepted",
    "parsedRegistryRevision": 2
  },
  "replacementCalls": 1,
  "callerObjectRevision": 2
}
```

**Impact**

The new parser does not remain behavior-free or fail closed under the packet's required post-import ambient-mutation
threat. A drifted safe receipt can pass its stated self-integrity check and mislead a consumer about revision,
chronology, references, or evidence digests.

The receipt still cannot set an authority field to `true` or directly disclose protected identity through this
reproduction, so this is Medium rather than High. It nevertheless blocks acceptance.

**Required remediation**

- Make ingress receipt construction and parsing use module-captured, behavior-free canonicalization and hash operations,
  or add a complete captured-runtime guard before any dynamic operation can execute.
- Because `receive()` contains awaited delivery, read, and intake seams, re-establish runtime integrity after each await
  and before receipt construction and validation unless the shared digest implementation itself becomes behavior-free.
- Cover every operation selected by canonicalization and hashing, including object keys, array traversal, sorting and
  joining, JSON encoding, numeric checks, and hash update/digest methods.
- Add post-import regressions proving replacements execute zero times and a drifted receipt always fails as
  `integrity_failed`, both through the direct parser and the composed receipt-return path.

### Low

None.

## Mandatory attack questions

1. **Routing hint isolation:** Invalid delivery IDs are rejected before delivery or replay. A syntactically valid
   mismatched hint may leave independently authenticated outer delivery as honest durable evidence, but it cannot feed a
   different delivery into intake because the coordinator re-reads by the hint and compares its evidence digest with the
   authenticated receipt.
2. **Exact delivery-evidence binding:** In the canonical runtime, the composition binds the parsed delivery receipt,
   canonical durable receive time, protected-delivery digest, intake receipt digest, and intake recorded time. Caller
   labels do not supply those proof values.
3. **Two independent proofs:** Outer frame authentication and scope binding remain separate from intake's database key
   resolution and nested enrollment verification. The concrete composition constructs both accepted implementations;
   neither proof port is caller-injected.
4. **Forged, cross-scope, inactive, expired, changed, duplicate-domain, and malformed inputs:** The cryptographic and
   persistence paths fail closed, and a valid outer frame with an invalid inner signature can create only outer delivery
   evidence. M-001 nevertheless permits a misleading final receipt after ambient mutation.
5. **Replay and recovery:** Under the canonical runtime, durable delivery precedes intake, registry/audit persistence is
   transactional, exact retry reconstructs the original result without duplicate rows, and changed-content reuse
   conflicts. Focused recovery and response-loss tests passed.
6. **Concurrency and chronology:** Existing locks serialize exact concurrent retries and stored chronology prevents
   normal-runtime receipt drift. M-001 remains an independent final-parser failure.
7. **HMAC key separation and custody:** The composition requires three distinct exact 32-byte keys, copies them into the
   accepted boundaries, wipes temporary copies, and leaves caller-owned keys untouched.
8. **Behavioral inputs, mutable host behavior, malformed results, and safe errors:** Proxy/accessor inputs and malformed
   dependency/database results are structurally rejected, and downstream errors map to bounded codes. M-001 proves a
   post-import ambient replacement can execute and bypass one final check.
9. **Proof-port substitution:** The generic coordinator is not exported. The public database composition constructs the
   concrete delivery and intake implementations internally without caller-injected proof ports.
10. **Safe receipt and negative authority:** The receipt omits protected identity and fixes all five authority fields to
    false, but M-001 prevents relying on its digest as a fail-closed drift check under ambient mutation.
11. **Protected-delivery parser export:** The export/rename preserves the existing validation ordering, recomputation,
    expected-ID/time checks, and error surface. No clean-runtime LIVE-030 semantic change was found.
12. **Disabled runtime and absence of activation:** The local runtime instantiates only the disabled ingress. The app has
    no ingress port or write route, and the product adds no listener, connector, native/provider action, credential use,
    production contact, deployment, or network effect.

## Repository and effect confirmation

- No product or tracked file was modified by the reviewer.
- The shared checkout remained clean.
- TypeScript generated `tsconfig.tsbuildinfo` only inside the disposable archive.
- The architect removed the exact disposable archive and confirmed its absence.
- No network access, GitHub write, listener, SSH, Hermes, provider, credential, native qualification, production
  infrastructure, deployment, MCP, plugin, or external effect occurred.
- Stage zero was readiness preparation only; no native attempt occurred.

## Final disposition

`rejected`

All mandatory deterministic checks passed, but M-001 is an unresolved Medium defect. The immutable product target cannot
be accepted until a different exact remediation target closes the ambient-operation execution and receipt-integrity
bypass with regression evidence.

This report grants no integration, listener, enrollment, connector, native, provider, production, deployment, approval,
acknowledgement, network, command, lease, or execution authority.

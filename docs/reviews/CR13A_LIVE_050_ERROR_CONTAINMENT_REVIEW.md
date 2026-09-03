# CR13A-LIVE-050 bounded error-handling independent review

**Disposition:** `rejected`

## Review identity and scope

- Original product: `b86e60e5f8389029030deaaada890267e5f92f53`
- Superseded first remediation: `7c79837cb60e497a7f49a203f20382afe133bd91`
- Immutable second-remediation target: `bbd3bcbd659ab91461bb52117718a95098c7bb80`
- Exact reviewed diff: `7c79837cb60e497a7f49a203f20382afe133bd91..bbd3bcbd659ab91461bb52117718a95098c7bb80`
- The reviewer differed from the producer and both completed prior reviewers.
- Review mode was read-only and report-only, with zero repair budget.
- Runtime: Node `v22.22.3`; pnpm `11.19.0`.
- Product commands ran from a detached exact-target disposable copy using the prepared dependency tree.

## Required command outcomes

| Command | Outcome |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit `0`; `ready_for_runtime_check`; lockfile SHA-256 `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`; no native attempt |
| `./node_modules/.bin/tsc --noEmit` | Exit `0`; no diagnostics |
| `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next` | Exit `0`; no diagnostics |
| Focused intake/delivery/ingress tests | Exit `0`; `24/24` passed, zero failed/skipped/cancelled |
| `npm run test:cr13a-connections` | Exit `0`; `39/39` passed, zero failed/skipped/cancelled |
| `node --import tsx scripts/verify-migrations.ts` | Exit `0`; migrations `0001` through `0036` applied; `119 PostgreSQL tables` verified |
| `git diff --check 7c79837cb60e497a7f49a203f20382afe133bd91..bbd3bcbd659ab91461bb52117718a95098c7bb80` | Exit `0`; no output |

## Closure decisions

### M-001

`M-001 is closed.`

The selected receipt runtime remains checked at receive entry (`src/connection-registry/v1/node-ingress.ts:298-300`),
after delivery (`:311-316`), after protected read (`:320-325`), after intake (`:338-347`), and before final receipt
construction (`:353-359`). The unchanged 20-operation regression passed with zero replacement execution, and the
post-intake-commit regression again returned bounded `integrity_failed` before replacement behavior, then recovered the
single revision-1 result after restoration.

### M-002

`M-002 is closed for the reported behavior-execution and raw-escape defect.`

`exactHostErrorCodeV1` rejects a direct Proxy before reflection, compares only the immediate prototype, and reads only an
own string data descriptor. Both committed database-rejection regressions passed: zero Proxy/accessor behavior ran, the
rejected values did not escape unchanged, the result was a fresh bounded ingress error, the preexisting replay count
remained exactly one, and delivery, intake, and registry counts remained zero.

An independent local classifier probe additionally covered a direct Proxy, an ordinary value with a Proxy immediate
prototype, an exact-prototype accessor, and an inherited code. All were rejected with zero behavior execution; only an
exact-prototype own string data property was read.

The Low finding below is a distinct allowlist-completeness defect. It does not reopen M-002's demonstrated Proxy
execution or raw-value escape, but it prevents acceptance.

## Findings

### High

None.

### Medium

None.

### Low

#### L-001 — Protocol-authentication catch accepts every string instead of the declared code allowlist

**Evidence**

- `src/security/host-value.ts:62-68` returns any own string value after the exact-prototype checks.
- The actual protocol authentication allowlist contains seven values at `src/node-protocol/v1/authentication.ts:16`.
- `src/connection-registry/v1/node-delivery.ts:586-590` tests only whether the returned code is non-`undefined`. It
  therefore classifies any own string on an object with the captured `ProtocolAuthenticationError.prototype` as
  `authentication_failed`.
- This differs from the explicit comparisons used by the registry, intake, delivery, and ingress safe-code classifiers
  and violates ADR-154's requirement that a preserved code be in the boundary's allowlist.

A bounded local probe made the ordinary database query reject:

```ts
const rejected = Object.create(ProtocolAuthenticationError.prototype);
Object.defineProperty(rejected, "code", {
  value: "not_in_protocol_authentication_allowlist",
});
```

Observed adapter result:

```json
{
  "constructor": "ConnectionEnrollmentNodeDeliveryErrorV1",
  "safeCode": "authentication_failed",
  "rawEscaped": false
}
```

Observed public ingress result:

```json
{
  "constructor": "ConnectionEnrollmentNodeIngressErrorV1",
  "safeCode": "authentication_failed",
  "rawEscaped": false
}
```

Expected for a non-allowlisted downstream value was conservative `integrity_failed`.

**Impact**

An ordinary same-process database seam can misclassify an unknown infrastructure or integrity rejection as caller
authentication failure. The value remains bounded, executes no behavior, escapes no raw data, writes no persistence,
and grants no authority, so this is Low rather than Medium. It is nevertheless a correctness and diagnostic-integrity
defect in the second-remediation boundary.

**Required correction**

- Compare the captured protocol code against all seven `ProtocolAuthenticationCode` literals before returning
  `authentication_failed`.
- Convert every other string to fresh `ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed")`.
- Add adapter and composed-ingress regressions for an exact-prototype own-data object carrying a non-allowlisted string.
  Require `integrity_failed`, no raw escape, no behavior execution, and zero persistence.
- Freeze a new immutable target and obtain another different independent review.

## Answers to the twelve verification questions

1. **Pass.** `exactHostErrorCodeV1` rejects a direct Proxy first, requires the exact immediate captured prototype, and
   reads only an own string data descriptor.
2. **Pass.** Direct Proxy rejection and an ordinary rejection with a Proxy immediate prototype executed zero
   Proxy/accessor behavior in both committed regressions and the independent probe.
3. **Pass.** No `instanceof` remains in caught-value classification in the registry store, intake, node-delivery
   adapter, or ingress coordinator.
4. **Fail.** Every path constructs a fresh bounded local error and no raw caught value is rethrown, logged, or
   serialized, but the protocol-authentication catch lacks its required explicit seven-code allowlist. See L-001.
5. **Pass.** Genuine exact local errors retain the documented invalid-input, authentication, scope, replay, integrity,
   and source-unavailable mappings. The focused suite exercised these mappings.
6. **Pass.** Both database-rejection regressions prove zero behavior, a fresh bounded ingress error, replay count exactly
   `1`, and delivery/intake/registry counts exactly `0`.
7. **Pass.** M-001's checks remain at entry, after each of the three awaited proof seams, and before final receipt
   construction. The 20-operation and post-intake-commit cases remain unchanged and pass.
8. **Pass.** Outer node-frame authentication precedes delivery persistence; intake separately resolves the current
   database key and verifies the nested enrollment. Routing remains bound to protected delivery evidence.
9. **Pass.** Delivery, registry, and intake-audit keys must be three distinct 32-byte domains. Exact/later/concurrent
   replay and definite response-loss recovery remain stable in the passing focused suite.
10. **Pass.** The public receipt remains an exact derived-field projection with all five authority fields fixed false and
    no protected identity, locator, credential, signature, or transport detail.
11. **Pass.** The local runtime still composes `DisabledConnectionEnrollmentNodeIngressV1`; no application write route,
    listener, connector, native/provider call, credential access, production contact, deployment, or network operation
    was added or used.
12. **Fail.** L-001 is a new Low correctness and diagnostic-integrity defect. No new High or Medium defect was found.

## Repository, cleanup, and effect confirmation

- The shared checkout remained unchanged and clean.
- The disposable checkout remained detached at exact target `bbd3bcbd659ab91461bb52117718a95098c7bb80`, with no
  tracked changes.
- TypeScript created only ignored `tsconfig.tsbuildinfo` inside the disposable copy. The optional probes were inline and
  created no files.
- The architect removed the exact disposable path and confirmed its absence after receiving this report.
- No network access, GitHub write, listener, SSH, Hermes, provider, credential, native qualification, production
  infrastructure, deployment, MCP, plugin, commit, push, or external change occurred.
- Stage zero was readiness evidence only.

## Final disposition

`rejected`

M-001 and M-002's reported defects are closed, and every required deterministic command passed. Acceptance is blocked
by Low finding L-001.

This report grants no integration, listener, enrollment, connector, native, provider, production, deployment, approval,
acknowledgement, network, command, lease, or execution authority.

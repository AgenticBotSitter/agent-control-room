# CR13A-LIVE-050 protocol-code allowlist independent re-review

**Disposition:** `accepted`

## Review identity and scope

- Superseded target: `bbd3bcbd659ab91461bb52117718a95098c7bb80`
- Immutable remediation target: `ffcdb586022ff67494cb2e404df7749b3a093b22`
- Exact reviewed diff: `bbd3bcbd659ab91461bb52117718a95098c7bb80..ffcdb586022ff67494cb2e404df7749b3a093b22`
- The reviewer differed from the root Codex producer and all three completed prior reviewers.
- Review mode was independent, read-only, and report-only with zero repair budget.
- Runtime: Node `v22.22.3`; pnpm `11.19.0`.
- Commands ran from a local disposable copy detached at the exact target, using the existing prepared dependency tree.
- The target HEAD and expected tree resolved to `ffcdb586022ff67494cb2e404df7749b3a093b22` and
  `7a5ff3702cce108705bdbd7731941f6c1aa25b42`.

All three earlier rejected reports remain durable, with verified SHA-256 values:

- M-001 report: `ae40c366c16ac9d72cdc0be6db0393fd02904eef77b07b3e04bd8a07b7c6b255`
- M-002 report: `67b8eaeffd6bbcc86eb81d061107beaf464b5dcb0f680317ad3d18cb89c85992`
- L-001 report: `61c934aca63942f043b613e5137b1ba2824f5f2139534031ba62ad65e732a86b`

## Required command outcomes

| Command | Outcome |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit `0`; `ready_for_runtime_check`; lockfile SHA-256 `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`; no native attempt |
| `./node_modules/.bin/tsc --noEmit` | Exit `0`; no diagnostics |
| `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next` | Exit `0`; no diagnostics |
| Focused intake/delivery/ingress tests | Exit `0`; `26/26` passed; zero failed, cancelled, skipped, or todo |
| `npm run test:cr13a-connections` | Exit `0`; `41/41` passed; zero failed, cancelled, skipped, or todo |
| `node --import tsx scripts/verify-migrations.ts` | Exit `0`; migrations `0001` through `0036` applied; `119 PostgreSQL tables` verified |
| `git diff --check bbd3bcbd659ab91461bb52117718a95098c7bb80..ffcdb586022ff67494cb2e404df7749b3a093b22` | Exit `0`; no output |

Bounded static comparison independently extracted the declared and recognized authentication-code lists. It returned:

```json
{
  "declared": [
    "malformed_frame",
    "unsupported_version",
    "expired",
    "unauthenticated",
    "forbidden",
    "replayed",
    "rate_limited"
  ],
  "recognized": [
    "malformed_frame",
    "unsupported_version",
    "expired",
    "unauthenticated",
    "forbidden",
    "replayed",
    "rate_limited"
  ],
  "exactMatch": true,
  "count": 7
}
```

A scoped source search found zero `instanceof` occurrences under `src/connection-registry/v1`.

A base-to-target quiet diff confirmed no changes to `host-value.ts`, registry store, intake, ingress, local runtime,
application connection route, or migrations. The only runtime change is nine insertions and one deletion in
`node-delivery.ts`; the two test files each add one 33-line regression.

## Closure decisions

### M-001

`M-001 is closed.`

The target does not change ingress receipt parsing or construction. Runtime integrity remains checked at receive entry,
immediately after delivery, protected-read, and intake awaits, and before final receipt construction.

The unchanged 20-operation replacement matrix and post-intake-commit regression both passed. Replacements executed zero
times, failures remained bounded `integrity_failed`, and restoration preserved exact response-loss recovery.

### M-002

`M-002 is closed.`

The behavior-free `exactHostErrorCodeV1` implementation and every connection-registry catch boundary are unchanged from
the previously reviewed second remediation. No `instanceof` caught-value classification exists.

The direct self-throwing Proxy and unusual immediate-prototype regressions passed with zero Proxy/accessor execution,
fresh bounded errors, no raw-value escape, replay count unchanged at one, and zero delivery, intake, or registry
persistence. The new L-001 regressions use the same behavior-free exact-prototype/own-data classification and do not
weaken M-002.

### L-001

`L-001 is closed.`

`ProtocolAuthenticationCode` declares exactly these seven literals:

- `malformed_frame`
- `unsupported_version`
- `expired`
- `unauthenticated`
- `forbidden`
- `replayed`
- `rate_limited`

`capturedProtocolAuthenticationCodeV1` enumerates exactly those seven values. Its conditional returns `undefined` for
every other string. The delivery catch maps a recognized value to a fresh
`ConnectionEnrollmentNodeDeliveryErrorV1("authentication_failed")` and every unrecognized value to a fresh
`ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed")`.

The adapter and complete-ingress regressions use ordinary non-Proxy values whose immediate prototype is exactly
`ProtocolAuthenticationError.prototype`, whose `code` is an own string data property containing an unknown value, and
whose `message` is a throwing accessor. Both passed with:

- zero accessor execution;
- no raw rejected-value escape;
- conservative `integrity_failed`;
- replay baseline exactly `1`;
- zero delivery persistence;
- and, through the complete ingress case, zero intake and registry persistence.

Existing genuine malformed-frame and forged-signature cases still map to `authentication_failed`, preserving accepted
LIVE-040 behavior.

## Answers to the ten verification questions

1. **Pass.** A captured protocol code is accepted only if it equals one of the seven declared literals. Static
   extraction confirmed exact set and order equality with seven unique entries.
2. **Pass.** Every other string yields `undefined` from the classifier and is reconstructed as a fresh bounded delivery
   `integrity_failed` error.
3. **Pass.** Both regressions use ordinary exact-prototype objects with an unknown own string data code and a throwing
   `message` accessor; both record zero accessor reads.
4. **Pass.** The adapter returns fresh delivery `integrity_failed`; composed ingress returns fresh ingress
   `integrity_failed`. Neither exposes the rejected value.
5. **Pass.** The regressions preserve the fixture's single preexisting enrollment replay row. Delivery remains empty in
   both; the composed test additionally proves intake and registry remain empty.
6. **Pass.** Genuine protocol-authentication failures still map to `authentication_failed`. Existing forged-frame and
   invalid-frame LIVE-040 regressions pass unchanged.
7. **Pass.** M-001 runtime-integrity checks and M-002 behavior-free exact-prototype/own-data classification are unchanged
   and remain closed.
8. **Pass.** Proof ordering, routing-evidence binding, three distinct HMAC domains, exact replay, concurrent replay, and
   response-loss recovery code are unchanged. Their focused regressions pass.
9. **Pass.** Receipt fields and all five false authority values are unchanged. The disabled local ingress runtime and
   absence of an application ingress route or listener remain verified.
10. **Pass.** No new High, Medium, or Low correctness, integrity, privacy, recovery, or availability defect was found.

## Findings

### High

None.

### Medium

None.

### Low

None.

## Repository, cleanup, and effect confirmation

- The shared checkout remained clean during review.
- Before cleanup the disposable copy remained detached at the exact target with no tracked, staged, or untracked
  product changes. Only ignored TypeScript build metadata and the prepared dependency link were present.
- The architect completed cleanup after review and confirmed the exact disposable path was absent.
- No source or report was edited by the reviewer. No commit or push occurred.
- No network access, GitHub write, listener, SSH, Hermes, provider, credential, native qualification, production
  infrastructure, deployment, MCP, plugin, or external effect occurred.
- Stage zero was readiness evidence only and did not consume a native attempt.

## Final disposition

`accepted`

M-001, M-002, and L-001 are closed. Every required deterministic command passed, the seven-code allowlist exactly
matches the declared protocol type, every other string closes conservatively, and no new High, Medium, or Low finding
remains.

This report authorizes integration review only. It grants no listener, enrollment, connector, native, provider,
production, deployment, approval, acknowledgement, network, command, lease, or execution authority.

# CR13A-LIVE-050 receipt-integrity remediation independent re-review

**Disposition:** `rejected`

## Review identity and scope

- Superseded product: `b86e60e5f8389029030deaaada890267e5f92f53`
- Immutable remediation target: `7c79837cb60e497a7f49a203f20382afe133bd91`
- The independent reviewer differed from both the producer and the completed first reviewer.
- Review mode was read-only and report-only, with zero repair budget.
- Product commands ran from a disposable exact-target archive with the repository's prepared dependencies.
- Runtime: Node `v22.22.3`; pnpm `11.19.0`.

## Required command outcomes

| Command | Outcome |
|---|---|
| Stage zero | Exit `0`; `ready_for_runtime_check`; no native attempt |
| TypeScript `--noEmit` | Exit `0`; no diagnostics |
| Full ESLint | Exit `0`; no diagnostics |
| Focused intake, delivery, and ingress tests | Exit `0`; `22/22` passed |
| Complete connection slice | Exit `0`; `37/37` passed |
| Migration verification | Exit `0`; migrations `0001` through `0036`; `119 PostgreSQL tables` |
| Exact remediation `git diff --check` | Exit `0`; no output |

## M-001 closure decision

`M-001 is closed.`

- `src/connection-registry/v1/node-ingress.ts:32-76` captures the selected receipt-processing runtime, including native
  hash update/digest operations.
- `src/connection-registry/v1/node-ingress.ts:78-121` verifies those selections with captured descriptor operations and
  a canonical digest sentinel.
- Direct parsing checks before snapshotting, validation, canonicalization, or hashing.
- Receive checks at entry and after delivery, protected-read, and intake awaits, then again before construction.
- The 20-operation regression restores every descriptor and records zero replacement executions.
- The intake-commit seam regression returns bounded `integrity_failed`, then exact replay recovers revision `1` after
  restoration without another revision.

No path equivalent to the original receipt-digest drift remained.

## Findings

### High

None.

### Medium

#### M-002 — A self-throwing Proxy rejection executes behavior and escapes the bounded ingress error contract

This defect was not introduced by the M-001 remediation lines, but it remains in the exact target.

**Evidence**

- The ordinary database port can reject during protected key resolution in
  `src/connection-registry/v1/node-delivery.ts:330-342`.
- The delivery catch classifies the unknown rejection with unguarded `instanceof` at
  `src/connection-registry/v1/node-delivery.ts:569-581`.
- The ingress catch passes the unknown value to `mapDeliveryFailureV1()` at
  `src/connection-registry/v1/node-ingress.ts:299-307`.
- That mapper performs another unguarded `instanceof` at `src/connection-registry/v1/node-ingress.ts:235-243`.

A temporary local check used a non-Proxy database object with ordinary methods. Its `query()` rejected with a Proxy whose
`getPrototypeOf` trap threw the same Proxy. The expected result was bounded `integrity_failed` with zero trap execution.
The observed result was:

```text
rawDownstreamProxyEscaped: true
proxyTraps: 2
```

No durable write occurred; failure was during key resolution before replay or delivery persistence.

**Impact**

A malformed rejected-promise value from the accepted database seam can run caller-controlled behavior twice and cross
the public ingress boundary as its raw object. The current runtime remains disabled and the reproduction creates no
authority or durable effect, so this is Medium rather than High.

**Required correction**

- Classify caught unknown values through behavior-free captured operations before any `instanceof`, property read,
  serialization, or logging.
- Reject Proxy errors directly as bounded `integrity_failed`.
- Correct both node-delivery and ingress classification so the trap runs zero times and no raw value escapes.
- Add an ordinary `DatabaseClient` rejection regression requiring zero traps, one bounded ingress error, and zero replay,
  delivery, intake, or registry writes.
- Re-run the packet and obtain another different independent review.

### Low

None.

## Required verification questions

1. **Direct parser ordering:** Pass. It verifies selected runtime before receipt processing.
2. **Selected boundary completeness:** Pass for receipt integrity, including native hash update/digest.
3. **Await boundaries:** Pass for successful settlements. M-002 separately affects rejected-promise classification.
4. **20-operation matrix:** Pass. All descriptors restored; replacements executed zero times.
5. **Committed-response recovery:** Pass. Restoration allowed exact revision-1 replay.
6. **Malformed results and error mapping:** Fail. M-002 permits behavior and raw escape.
7. **Independent authentication proofs:** Pass. Outer authentication remains separate from database-key inner
   verification, and the coordinator remains unexported.
8. **Key domains and custody:** Pass. Three distinct keys remain required; caller arrays are unchanged; temporary copies
   alone are wiped.
9. **Replay and routing stability:** Pass under bounded dependency behavior.
10. **Receipt shape:** Pass. Only declared derived fields and negative authority are present.
11. **Disabled defaults and effect boundary:** Pass. No live composition or external operation was added.
12. **New defects:** M-001 is closed, but inherited Medium M-002 remains in the exact target.

## Repository, cleanup, and effect confirmation

- No shared product or tracked file was changed by the reviewer.
- The optional check existed only in the disposable archive.
- The architect removed `/private/tmp/cr13a-live-050-rereview.4HDesM` and confirmed its absence.
- No internet access, GitHub write, machine connection, external agent, credential, provider, production infrastructure,
  listener, deployment, MCP, plugin, or native qualification was used.
- Stage zero was readiness evidence only.

## Final disposition

`rejected`

M-001 is closed and every required command passed, but M-002 remains. Acceptance requires bounded behavior-free error
classification, complete deterministic reproduction, and another different independent disposition.

This report grants no integration, listener, enrollment, connector, native, provider, production, deployment, approval,
acknowledgement, network, command, lease, or execution authority.

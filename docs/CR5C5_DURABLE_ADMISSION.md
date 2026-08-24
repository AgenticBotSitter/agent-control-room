# CR-5C.5 durable bridge-to-executor admission and refusal

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md`, ADR-033, and ADR-034
**Scope:** Durable accepted/refused policy decisions, delivery aliases, and bridge acknowledgement ordering

## Outcome

`SqliteLocalAdmissionStore` persists the immutable output of CR-5C.4 before any later executor may consume it. Each record contains only stable identity, local decision evidence/digests, disposition, and time—never the refused request payload, arguments, secret material, or private key bytes.

The operation key is the canonical digest of tenant, node, project, job, attempt, and normalized operation digest. The admission ID additionally binds request, ceiling, and lease-authority digests. A dedicated alias table maps any number of exact delivery message IDs to that admission. Therefore an exact fresh-message re-offer remains one durable decision rather than becoming new authority.

The database enforces one accepted admission per operation key. Refusals can remain as evidence while a genuinely different ceiling/authority/request combination is considered later, but a second accepted combination conflicts. Exact retries replay the originally persisted decision and `decidedAt`; they are not re-evaluated against a later clock merely because an acknowledgement was lost.

Production construction requires a filesystem path. SQLite memory/URI stores require an explicit test-only option. The store uses WAL, full synchronous commits, foreign keys, and an immediate transaction. Loaded records recompute operation, admission, and decision digests plus disposition to detect inconsistent persisted rows.

## Bridge ordering

`PortableNodeBridge` accepts an optional `BridgeCommandHandler`. For a handled job command, ordering is:

1. protocol authentication/replay guard durably records the frame as `received`;
2. the command planner produces normalized local policy input;
3. the pure evaluator decides and the admission store commits accepted/refused state;
4. only then does the bridge mark the inbox row `processed`; and
5. only then does it stage/send the protocol acknowledgement.

If the handler fails before commit, the frame remains `received` and no acknowledgement is sent. If a crash occurs after admission commit but before inbox processing, exact retry replays the durable decision. If a crash occurs after inbox processing but before acknowledgement, the existing bridge duplicate path sends a duplicate acknowledgement without running the handler again.

`DurablePolicyCommandHandler` returns a coarse refusal receipt at its integration seam. Actual protocol transport of that receipt waits for a frozen message type; this slice does not widen the CR-5A wire protocol implicitly.

## Deliberate stop boundary

An accepted admission is not an execution permit by itself. This slice does not dispatch an executor, reserve cost/concurrency, consume an approval, create an effect claim, write a pre-effect marker, retry an effect, issue approvals, run timers, perform target I/O, or deploy live integrations. The planner that translates a verified project command into normalized policy input remains an adapter responsibility and must not supply authority wider than the signed frame.

## Verification

`tests/node-admission.test.ts` covers restart durability, same-message replay, fresh-message aliases, decision conflicts, the one-accepted constraint, original-time replay, deterministic acceptance, and coarse refusal output. `tests/node-bridge.test.ts` proves a synthetic admission crash leaves the inbound frame unprocessed and unacknowledged, then succeeds on exact authenticated retry.

The repository completion gate remains `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.

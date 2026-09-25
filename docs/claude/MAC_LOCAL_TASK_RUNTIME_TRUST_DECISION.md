# Mac-local task runtime: trust decision for `assertCurrent`, `receiptPort` and keys

**From:** Claude (lead, security gate). **Date:** 2026-09-25. **Status:** DECIDED. Codex builds it
as package `codex/mac-w3-default-task-provider`. It supersedes the "MISSING" list at the top of
`docs/claude/DEFAULT_TASK_PROVIDER_PLAN.md`: `publish()` and all three delivery factories already exist.

This adds **no new authority**. Every check below re-uses a fence that already exists and has been
reviewed. If building any part of it seems to need a new authority source, stop and ask. Do not invent one.

## 1. `assertCurrent(delivery, route, signal)`: two existing fences, both required

The CLI bridge calls this three times: before the receipt, before spawn, and before publish. Each call
must pass **both** fences, and each fence fails closed.

**A. Canonical task authority.** This re-uses the agent's own `*DispatchPreparationV1`.
1. From `delivery.identity`, read the attempt's lease in `control_leases`. Match on the same tenant
   and attempt, with `state = 'active'`. There must be exactly one such lease; zero or several → throw.
   Read `inputDigest` from the job row. Build the agent's existing
   `*DispatchReferenceV1 { tenantId, projectId, jobId, attemptId, leaseId, inputDigest }`.
2. Call `preparation.prepare(reference)`. It already refuses a lease that isn't active or has expired,
   a job or attempt that isn't `leased`, a plan or adapter mismatch, and expired job authority.
3. Require **all** of the following:
   - `current.delivery.identity.runId === delivery.identity.runId`. The run id is derived from the
     lease id plus the plan digest, so a replaced lease or plan fails here.
   - `worker`, `input`, `inputDigest`, `authorityDigest`, `connectorProfileDigest`, `acceptanceProfileId`,
     `acceptanceProfileDigest` and `expiresAt` are equal.
   - `canonicalJson(current.route) === canonicalJson(route)`.
   - Do **not** compare `issuedAt`, `deliveryId` or `deliveryDigest`. Every `prepare()` stamps
     `issuedAt` with the current time, and the other two are derived from it, so they change on every
     call. (Correction, same day: an earlier draft said to compare `deliveryId`, which would refuse
     every real task. The helper built on 2026-09-25 compared `deliveryDigest`, with the same effect;
     its tests passed only because they froze the clock.)
4. Build one shared helper, `src/harness/v1/owner-trusted-local-cli-assert-current.ts`. Give it the
   preparation instance as a parameter. Use it for all three agents. Do not write three copies.

**B. Owner enablement.** This is the mac-local stand-in for the VPS "current admission digest",
per critical-path decision 5.
- The worker's current readiness from the host's existing `workerReadiness.read()` must be `ready`.
  That covers the pinned executable path and recorded version still matching the enablement record.
- `delivery.worker` must equal the exact adapter registry binding for that worker kind.
- An owner re-pin, an executable change or a revoked enablement between calls must make the next
  call throw.

**Required tests** (fake executables, disposable PostgreSQL):
- The lease is revoked, and then separately replaced, between receipt and spawn: no spawn happens.
- The same thing happens between the end of the process and publish: nothing is published.
- The worker becomes not-ready between receipt and spawn: no spawn happens.
- A delivery for worker X is sent to worker Y's bridge: refused.

## 2. `receiptPort`: in-process, not an authority

**Status:** already built as `src/harness/v1/owner-trusted-local-cli-receipt-port.ts` (commit `cc4c59fa`)
and reviewed against this section: it grants nothing and mints only the standard receipt. The binding
check below is done by the delivery bridge's own `validate()` before the port is called, so the port
itself refuses only a non-local route or a worker mismatch.

- It's a same-process loopback `ControllerWorkerDeliveryPortV1`. It returns
  `disposition: "accepted"` only if all of these hold:
  - `route.kind === "local"`;
  - `route.workerId` equals the binding's worker;
  - `delivery.worker` equals the binding.
- Otherwise it returns `"rejected"`. `receiptDigest` is computed exactly as the receipt schema validates it.
- The one-shot execution fence is the **persisted, integrity-keyed receipt** that the bridge already
  writes. The port itself grants nothing.
- Do **not** reuse `codex-v1/local-delivery-composition.ts` or `claude-code-v1/local-delivery-composition.ts`.
  They implement a different, remote activation protocol.

## 3. Keys: a new protected file, not new fields

- Leave `MacLocalProtectedConfigurationV1` at its six keys.
- Add a separate owner-only, data-only file: `Protected/config/task-runtime.json` (0600, not a
  symlink), schema `control-room.mac-local-task-runtime/v1`, validated with an exact-keys check.
- It holds six 32-byte keys, base64url-encoded, **one per role**: `planning`, `review`, `harness`,
  `results`, `approvals` and `deliveryReceipt`. No two roles share a key. (Correction, same day: an
  earlier draft said one independent key per consumer. That would make startup refuse, because the
  existing code requires some consumers to share a key: `validateTaskQualityKeys` insists that the
  quality key equals the planner's review key and the website review key, that the quality harness
  key equals the website harness key, and that the quality results key equals the website results key.)
  The provider maps each role to its consumers:
  - `planning`: the planner's `integrityKey`;
  - `review`: the planner's `reviewIntegrityKey`, `quality.integrityKey`, the website review key and the
    durable result review key;
  - `harness`: the run store (`runIntegrityKey`), `quality.harnessIntegrityKey` and the website harness key;
  - `results`: the durable result `integrityKey`, `quality.results.integrityKey` and the website results key;
  - `approvals`: `NativeApprovalPacketStore`;
  - `deliveryReceipt`: the CLI bridge's receipt `integrityKey`.
- It also holds the protected Hermes run settings: profile, provider and model. These are data, not a
  source pin.
- Keys are generated once, by `pnpm mac:prepare-task-runtime` (built in package 3), with `crypto.randomBytes(32)`.
  - Any two identical keys → refuse.
  - A key of the wrong length → refuse.
  - The file exists but is invalid → refuse. Never regenerate over it.
  - `mac:up` never rewrites an existing file.
- It's never printed, logged, or put into task input.

## 4. The rest of the provider (reuse only)

- **Queue:** use `nativeQueue` plus `preparePgBossNativeTaskSubmission` on the coordinator role, the
  same way as the existing installed queue (`installed-native-queue.ts`).
- **Approvals:** use `NativeApprovalPacketStore` with the approvals key and an **empty remote-trust
  list**, as `tests/codex-owner-trusted-local-queue.test.ts` does. The owner's approval goes through the
  existing website approval route. If the journey's approve step can't complete with an empty trust
  list, stop and ask. Don't add a trust entry.
- **Routes:** three static local entries, one per worker.
- **Templates:** build three per active project when the provider starts.
  - Accepted limitation for W7: a project created after `mac:up` needs `mac:down && mac:up` before
    it can get tasks.
  - The 16-template cap limits this to about 5 projects.
  - State both points in `OWNER_GUIDE_MAC.md`. Refuse with a clear error instead of dropping
    templates silently.
- **Publish:** use the existing `createOwnerTrustedLocalCliPublishV1` with the results role.
  - Accepted limitation for this phase: a revocation that lands *during* the publish transaction is
    not caught mid-flight. Fence A runs immediately before publish.
  - Record this in `MAC_LOCAL_EVIDENCE.md` limitations.
- **Build entry:** add `macLocalDefaultTaskProvider` to `vite.vps.config.ts`, so that `up.mjs`'s
  existing `dist-vps/server/macLocalDefaultTaskProvider.js` path exists.

## 5. Review and done

- Split the work into packages of no more than about 800 lines, in this order:
  1. fence A plus fence B helper and tests;
  2. receipt port;
  3. `task-runtime.json` loader and generator;
  4. provider assembly plus build entry.
- Each package goes through `claude-review.mjs`. Packages 1 and 3 need an Opus review.
- **Done when**, on the rehearsal database:
  - `mac:up` starts;
  - `GET /api/v1/local-workers` lists all three workers as ready;
  - one fake-executable task per worker reaches pending review exactly once.

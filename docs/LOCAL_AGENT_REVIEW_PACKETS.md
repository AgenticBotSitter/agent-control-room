# Local agent review packets

These are bounded, source-only packets for the local build. They are not
Control Room tasks yet: no installed website or worker is live.  Each worker
uses its own checkout or read-only copy, does not inspect protected
configuration, and returns a short report with commands run and exact findings.

## Packet A — Hermes route verification

**Suitable worker:** a local Hermes Agent configured by the owner.

**Objective:** independently verify that the local Hermes route uses the
existing Control Room task lifecycle rather than a second queue or result
system.

**Read only:**

- `src/harness/hermes-021-v1/local-delivery-composition.ts`
- `src/harness/hermes-021-v1/subprocess-stream-json-host.ts`
- `src/web/v1/hermes-021-private-installation-composition.ts`
- `src/installer/v1/private-installed-local-hermes-runtime-composer.ts`
- `tests/hermes-021-local-delivery-composition.test.ts`
- `tests/hermes-021-owner-authorized-local-only-runner.test.ts`

**Questions to answer:**

1. Is a receipt saved before Hermes can start?
2. Does an authority check occur immediately before the process boundary?
3. Does replay/restart avoid a second Hermes attempt?
4. Does the terminal result enter the existing review/correction lifecycle?
5. Identify only concrete defects, missing tests, or contradictions. Do not
   propose a new scheduler, broker, database, or result store.

**Allowed verification:** run:

```sh
npx --yes pnpm@11.19.0 exec tsx --test --test-concurrency=1 \
  tests/hermes-021-local-delivery-composition.test.ts \
  tests/hermes-021-owner-authorized-local-only-runner.test.ts
npx --yes pnpm@11.19.0 check
```

`pnpm check` is the product's supported release TypeScript check. It does not
claim to type-check every experimental test in the repository. Do not run a
real Hermes task, access a profile, read credentials, or alter configuration.

**Return:** a short report with pass/fail findings, exact files/lines for any
defect, and whether the result supports a real owner-attended proof next.

## Packet B — Claude installed-route review

**Suitable worker:** an independent Claude Code reviewer using its strongest
available review model.

**Objective:** verify that the installed local Claude route is a real addition
to the same Control Room task/result/review/correction lifecycle as Hermes,
and that the owner website can report only verified readiness rather than a
made-up running status.

**Read only:**

- `src/installer/v1/local-claude-post-install-admission.ts`
- `src/installer/v1/private-local-installation-runtime-assembly.ts`
- `src/installer/v1/private-local-installation-operator.ts`
- `src/web/v1/private-agent-task-operator-configuration.ts`
- `src/harness/claude-code-v1/local-process-readiness.ts`
- `tests/private-local-installation-runtime-assembly.test.ts`
- `tests/hermes-claude-shared-lifecycle-conformance.test.ts`

**Questions to answer:**

1. Does Claude use the existing saved receipt, result review, correction, and
   recovery path rather than a separate queue or storage system?
2. Is the recorded Claude readiness verified and tied to the same installation
   plan before it can be displayed or used?
3. Does the protected operator status distinguish “ready to be qualified” from
   “a live task was completed”?
4. Identify only concrete defects, missing tests, or contradictions. Do not
   propose a new scheduler, broker, database, or result store.

**Allowed verification:** run the focused Claude/local shared-lifecycle tests
and `npx --yes pnpm@11.19.0 check` (the supported release TypeScript check).
Do not start Claude, sign in, access protected configuration, read
credentials, or change files.

**Return:** a short report with pass/fail findings, exact files/lines for any
defect, and whether the result supports the next owner-attended qualification.

## Packet C — Codex Mac route security review

**Suitable worker:** an independent higher-capability reviewer.

**Objective:** determine whether the candidate managed Mac Codex route has a
supported, safe private-state mechanism. The desktop chat is out of scope and
does not count as a worker.

**Read only:**

- `docs/CODEX_MACOS_NATIVE_PROCESS_CUSTODY.md`
- `docs/LOCAL_MAC_CODEX_ROUTE_DECISION.md`
- `src/harness/codex-v1/macos-owner-trusted-process.ts`
- `src/node-bridge/private-codex-configuration.ts`
- related Codex tests under `tests/`

**Questions to answer:**

1. Does the candidate eliminate the private-state path replacement risk, or
   merely check the path before opening it?
2. Is there a supported upstream mechanism that can replace normal
   pathname-based private state without a custom unsafe wrapper?
3. If no, confirm the exact reason local Codex must stay unavailable.
4. If yes, describe the smallest integration using existing Control Room
   lifecycle components and the tests required before live qualification.

**Boundary:** no Codex process, login, account, credential, service, or native
operation. Do not weaken the existing safety rule simply to make the worker
appear ready.

**Return:** an evidence-backed accept/block recommendation.  A block report is
useful and should state the smallest condition that would reopen the work.

## How results are used

The lead integrator reviews every report, decides whether a change is needed,
and keeps the five-phase tracker current.  A report does not authorize a
worker, enable a route, or merge a change.

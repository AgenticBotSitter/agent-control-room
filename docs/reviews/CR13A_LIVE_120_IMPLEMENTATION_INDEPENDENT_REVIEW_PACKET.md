# CR13A-LIVE-120 independent implementation review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product target:** `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`
**Parent:** `671bfecdf199d7910aae48914687722254262350`
**Integrated design base:** `1ee5409c0b66afbd802582459af864ec0d198f5c`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Native effects permitted:** none

## Reviewer role

Review exact commit `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`. Do not review a moving branch. Be independent
of the producer and do not modify, repair, rebase, amend, merge, push, or run the native backend. Preserve every
finding, including a negative result. Any High, Medium, or Low finding rejects the target.

The review is repository-only. Do not open a socket or port, invoke a listener, issue or synthesize a private bind
capability, monkeypatch the implementation to make its native path reachable, start SSH, read credentials, contact
Hermes or a provider, use production data, deploy, or perform a native qualification. Dynamic tests may use only the
repository fake. Static inspection must cover the unreachable physical backend.

## Exact change

The product commit contains exactly:

- `src/connection-registry/v1/private-loopback-physical-native-driver.ts`;
- `tests/connection-enrollment-private-loopback-physical-native-driver.test.ts`; and
- registered test-script changes in `package.json`.

The one new server-driver module may import `node:net`. Two older files elsewhere in `src` import only `isIP` from
`node:net`; they are not listener modules and are outside this change. No second connection-registry module may import
`node:net`, and no other module may import or re-export the new physical-driver module.

## Required attacks

Review and, where effect-free, add temporary out-of-tree tests for all of the following without changing the target:

1. exact contract-to-implementation, implementation-to-driver, driver-to-status, and cross-driver provenance;
2. copies, aliases, re-digested values, accessors, symbols, Proxies, unusual prototypes, subclasses, borrowed
   receivers, method replacement, function decoration, `call`/`apply`/`bind`, and thenable behavior;
3. post-import replacement of every security-relevant ambient intrinsic, Node server/socket prototype method, timer,
   typed-array constructor, digest helper, and frame-decoder boundary that can be tested without a native call;
4. duplicate, concurrent, reentrant, stale, and out-of-order prepare/start/status/close/recover operations;
5. one-use start, pre-bind failure, post-marker uncertainty, cleanup failure, late settlement, skipped close, repeated
   close, restart recovery, and every possible automatic-retry or state-promotion bypass;
6. literal IPv4 loopback enforcement, private port custody, exact capability/attempt/contract/implementation binding,
   exclusive-port evidence, owner-window spend, durable marker, signer trust, tunnel-peer proof, and host-key custody;
7. one admitted connection, rejection of extras, zero application queue, one protected frame, trailing/second-frame
   rejection, maximum chunks/bytes, allocation bounds, backpressure watermarks, and hard buffer ceiling;
8. start, admission, connection, idle, frame, total-attempt, drain, and shutdown deadlines, including late callbacks
   after timeout or terminal state;
9. ordered close, server-close timeout, socket destruction, timer clearing, capability release, retained resource
   possibilities, and the distinction between cleanup success and independent signed physical proof;
10. public output and error sanitation for raw address, port, listener identity, path, PID, host/user identity, owner,
    tunnel peer, host key, credential, command, protected frame, provider value, native error, and stack text;
11. fake/native, owner, signer, platform, port, tunnel, host-key, cleanup, recovery, activation, approval, command,
    lease, execution, and network-authority relabeling; and
12. static imports and every browser, API, local-pilot, worker, scheduler, Hermes, service, startup, deployment,
    package barrel, and build route for accidental construction or wiring.

Specifically confirm that `nativeBindCapabilitiesV1` has no insertion path, `createUnwiredNodeNetPortV1` is not
exported, the connection-registry barrel omits the module, no source consumer imports it, and running all approved
tests leaves listener/network counters at zero. Treat static unreachability as an implementation boundary only; do
not call it platform qualification.

## Reproduction commands

From a detached worktree at the exact target:

```text
git status --short
git rev-parse HEAD
git diff --check 671bfecdf199d7910aae48914687722254262350..959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
npm run test:cr13a-physical-native-driver
npm run test:cr13a
npm test
npm run posttest
npm run test:build
node --import tsx scripts/verify-migrations.ts
```

If stage zero is not ready, stop. Do not install, download, repair, or run a native readiness/qualification command.
The database fallback above is listener-free application verification; do not use a wrapper that needs an IPC server
when the platform sandbox forbids it.

## Required report

Return one immutable Markdown report containing:

- reviewer identity and explicit independence statement;
- exact target commit and clean checkout status;
- commands and exact pass/fail/skip counts;
- a table of High, Medium, and Low findings with stable IDs, evidence, impact, and required remediation;
- explicit coverage of all twelve attack groups;
- listener attempts, network I/O observations, replacement executions, and external effects, all as exact counts;
- confirmation that no repair or native path was run; and
- one final disposition: `accepted` only with 0 High, 0 Medium, and 0 Low findings, otherwise `rejected`.

A pass is evidence for ordinary owner-controlled integration review only. It does not create a bind capability, clear
physical blockers, authorize a native attempt, wire a runtime, or grant network, SSH, credential, provider,
production, or deployment authority.

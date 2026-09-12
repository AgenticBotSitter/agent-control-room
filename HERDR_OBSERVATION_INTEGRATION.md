# Optional Herdr project observations

Status: local projection, retention, collection coordination, protected API and
overview UI implemented and independently reviewed. A fixed-command subprocess
port is implemented, fake-tested and reviewed but remains unwired. Executable,
endpoint and live-host acceptance remain unfinished. No Herdr binary is bundled,
installed or started.

## What is reused

Target the evaluated Herdr v0.9.0 `pane list` CLI/JSON interface, source revision
`b99002ac99b09e00b4ca692436cb15a6b0d676f1`. The adapter derives from Control Room's
own earlier evaluation code; it does not copy Herdr terminal hosting or replace
the native execution connector. The interface retains panes carrying session
references even when agent detection is unknown. `agent list` did not provide
that coverage in the earlier disposable evaluation.

Herdr is an optional operator-managed dependency. Its root Apache-2.0 license
does not settle the complete native binary's third-party notices. Binary
redistribution requires target-specific dependency/license closure first.

## Existing application path

1. Trusted operator composition creates `createHerdrObservationSource` with an
   immutable tenant/workspace/project/source/enrollment binding and explicit
   permitted Herdr workspace IDs. Pane names or session IDs cannot enroll a source
   or claim a Control Room project.
2. `createHerdrCollector` receives that source and narrowly scoped identity and
   pane-list ports. An explicitly requested poll compares endpoint observations,
   projects only allowed panes and retains minimized rows. No timer or daemon is
   created by this coordinator.
3. Supply only the source's retained reader interface in the private process's
   optional `herdrObservations` configuration. Trusted startup now captures and
   validates these readers before database acquisition instead of silently
   discarding the setting. It captures the array, binding and bound view method;
   it does not read observations during validation or own collector shutdown.
   The JSON operator settings do not expose this programmatic capability.
   Composition supports up to 16
   distinct enrollment keys per project (256 configured readers overall), with
   a 1024-row aggregate response ceiling. Duplicate keys and oversized responses
   are refused, not silently truncated. Each source retains its own freshness
   and revocation state. Grouping retained readers is not remote transport.
4. GET `/api/v1/projects/:projectId/observations` reuses Access verification and
   current project authority. It does not invoke collector ports. Responses are
   validated, project-bound and `no-store`.
5. The project overview displays reported status and duplicate-reference warnings
   as advisory only. Five-second freshness includes request delay. The browser
   performs bounded retained-state checks, clears rows on reauthorization and
   pauses after 40 reads until explicit refresh.

Raw terminal text, paths, titles and session references are not returned. Opaque
hashes are correlation hints, not anonymization guarantees. A reported `done`
state does not complete a Control Room task, release a lease or verify cleanup.

## Revocation and lifecycle

Operator composition owns source replacement and collector shutdown. Revoke the
old source before publishing a replacement; never reuse an enrollment revision
for different workspace mappings. Closing the collector revokes retained data
and signals cancellation. Disconnect marks observations offline and invalidates
pending publication without deleting a workspace or stopping an agent.

A cancelled port that ignores cancellation retains the collector's admission
slot until it settles. Returning an unavailable result is not proof of native
process cleanup. No automatic retry or second concurrent operation is admitted
by that collector. Separate collectors are not a cross-process lifecycle lock.

## Remaining native acceptance

- Bind the exact approved executable/version and isolated configuration. No
  ambient executable discovery, arbitrary CLI arguments, plugin installation or
  automatic update/start is part of a pane-list read.
- Verify the exact local endpoint and owner-only directory/socket permissions;
  protect against path replacement and qualify the actual selected host. An
  inode observation is not authenticated peer identity.
- Qualify the implemented bounded process port with the approved executable and
  terminal cleanup evidence. Its fake-child tests do not prove OS behavior or
  descendant cleanup. It deliberately waits for child close, not merely kill().
- Qualify permissions and same-account exposure: Herdr's underlying API has
  mutating methods even though this adapter exposes only observations. Do not
  proxy the raw socket to the browser or call this a server-side read-only token.
- Connect operator-owned scheduling and resource shutdown in the intended
  deployment. Test actual restart/disconnect and physical browser behavior with
  disposable data under separately scoped host authority.
- Qualify each machine's collector and delivery path before claiming the page
  observes the full Mac/PC/VPS fleet. Current grouping is tested with injected
  retained readers, not cross-machine connections; unenrolled machines are absent.

Run `pnpm test:observations` for synthetic collector, source, API and DOM checks.
Passing this command does not discharge any native gate above.

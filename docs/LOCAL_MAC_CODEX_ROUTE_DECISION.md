# Local Mac Codex worker route

**Status:** candidate source direction; not yet an accepted or running worker.

## Decision

For a future single-Mac Control Room release, Codex may use an
**owner-trusted local App Server process**. It will receive one already-approved
Control Room task through the existing Codex task, journal, result, review, and
correction lifecycle.

This is deliberately the same practical trust model used by the local Hermes
route: the owner controls the Mac user account and protects the local Control
Room folder. It is not presented as protection from a malicious program already
running as that owner.

## Existing Mac safety gate

This candidate does **not** by itself reopen the previously recorded Mac Codex
execution boundary. Before it can enter the protected installed composition,
the product must satisfy both existing Mac custody requirements:

1. an owner-attended harmless qualification proves the selected executable's
   identity before it receives a real task; and
2. the Codex private-state location is protected by a supported mechanism that
   closes replacement races, rather than merely rechecking a pathname.

The current provider is useful disposable-source work: it proves how the
existing App Server lifecycle can accept a narrow Mac process capability. It
does not prove the second requirement, and it must stay unavailable in the
installed product until that requirement has a reviewed implementation and
independent security review. The desktop chat remains separate from this
worker throughout.

## Why this route

- The existing Codex App Server framing, current-authority check, task-start
  journal, result reader, and recovery code already provide the correct
  lifecycle. They are retained.
- The existing native launcher is Linux-only: it depends on Linux file
  descriptors and executable formats. It cannot prove a Mac worker simply by
  being renamed or configured for macOS.
- The desktop chat remains the owner's development interface. The worker is a
  separate, fixed-purpose command-line/App Server process.

## Fixed first capability

The first route is a supplied-text review task only:

- one approved task and one App Server session;
- a read-only, installation-owned working directory;
- no inherited project instructions, plug-ins, MCP tools, broad shell access,
  or automatic approval of effects;
- one bounded result returned through the ordinary saved-result and owner-review
  path;
- no automatic retry after an uncertain result or lost reply.

Writing code, changing repositories, using broader tools, or retaining a
session are separate later capabilities. They are not enabled by this route.

## Source package to build

1. Add a Mac-only, owner-attended qualification record for an exact selected
   Codex executable, its fixed `app-server` invocation, protected local state,
   and fixed text-review policy. Store only safe fingerprints and bounded
   measurements in its public evidence.
2. Add a one-use, installation-bound process provider. It must use the
   protected-state mechanism above and recheck the
   selected executable immediately before spawn, build fixed arguments and a
   small environment, and retire the entire child process on cancellation or
   deadline.
3. Inject that provider into the existing `createCodexLocalHostV1` and
   `deliverCodexLocalTaskV1` path only after the existing receipt and final
   authority checks. Replays must read existing records, not start Codex again.
4. Reuse the existing App Server start/read journals and canonical result
   publisher. Do not add a Codex-specific scheduler, queue, database, result
   store, or review path.
5. Prove with disposable process fixtures: changed/revoked work never spawns;
   one exact delivery starts once; cancellation retires the process; restart
   reads the saved result; malformed App Server output is refused; and a
   correction remains the same ordinary task lifecycle.

## Owner proof later

After source and disposable tests pass, the owner will have one short,
attended window to qualify the real local Codex executable and run one harmless
text-review task from the real website. A failed qualification stays visibly
unavailable; it is never converted into a generic local-Codex launch.

## Explicit non-goals

- Do not use the Codex desktop chat as an automatically managed worker.
- Do not import the Linux native launcher or weaken its Linux checks.
- Do not create a Mac database, second scheduler, message broker, or agent
  framework.
- Do not expose paths, secrets, account identities, or private service details
  in website pages, logs, GitHub, or this document.

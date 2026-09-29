# Installation journal native reuse decision

**Status:** accepted source direction; no native helper has been installed or
qualified by this decision.

## Decision

Build one small Control Room-specific macOS connector for the existing
operation-scoped installation-journal storage session. Keep
`InstallationPlanFilesystemJournalV1` as the only journal and keep all plan,
transition, replay, recovery and concurrency decisions in TypeScript.

The connector is one long-lived native child per public journal operation. It
retains the complete ancestor chain, journal-root descriptor and any created
file descriptors until confirmed close. It implements only the already-defined
bounded list, stat, read, exclusive create, exact write, file sync,
no-replace link, exact-identity retirement, directory sync, root verification
and close operations. It is not a generic native command runner.

## Proven code to adapt

Adapt the repository's existing Apache-2.0 protected-directory implementation:

- `native/protected-directory-v1.c` for no-follow traversal, descriptor
  identity, ACL checks, deadlines, cancellation and bounded framing;
- `private-protected-root-native-directory.ts` for captured reviewed bytes,
  private executable staging, child ownership, cancellation, reaping and
  identity-checked cleanup;
- `macos-protected-directory-native-sidecar.mjs` for exact archive parsing,
  platform/architecture binding and manifest verification;
- `build-protected-directory-native.mjs` for the installed Apple toolchain,
  fixed hardening flags, deterministic artifacts, `LICENSE` and `NOTICE`;
- the existing fault/checkpoint, substitution, fragmentation, output-bound,
  cleanup-uncertainty and reproducible-build tests.

The one-shot protected-directory helper itself is not extended. It closes
ancestors while descending and exchanges one request and response, while the
journal contract requires a retained descriptor session and a strictly ordered
multi-command conversation.

## External candidates

| Candidate | License | Decision |
| --- | --- | --- |
| T3 Code | MIT | Reference only. Its installer and process patterns do not retain a macOS directory-descriptor journal session. |
| Hermes Agent, WebUI and Desktop | MIT | Reject for this seam. Their file/session paths do not provide the required native custody. |
| Herdr | Apache-2.0 | Reference only. It observes sessions and does not implement a durable installation journal. |
| Ralph Sandbox | MIT | Reference only for later containment; its container/worktree code does not solve local descriptor custody. |
| Open Code Review | Apache-2.0 | Reference only. Its bounded-read ideas do not provide the required native session. |
| pg-boss, etcd and OpenBao | permissive/MPL families | Reject. They solve queues or distributed state and would compete with Control Room authority. |

No outside source removes a planned file for this seam. Existing Control Room
code eliminates rebuilding the journal, recovery rules, storage-session
adapter, executable staging, archive parser, deterministic packaging and most
adversarial-test machinery. The only new machinery is the dedicated native
session helper and its narrow TypeScript process bridge, so no new third-party
notice is required.

## Installed-byte decision

The helper will ship as a distinct versioned sidecar staged under the private
installation root. Both release evidence and the installed manifest pin its
manifest and executable digests. The operator derives its location from the
already-verified release version. Environment variables, user-selected paths,
runtime compilation and downloading cannot select the helper.

`native_journal_operation_custody_missing` remains a live blocker until the
native helper, deterministic sidecar, installed manifest binding, operator
composition and adversarial tests are independently accepted. Owner-attended
native qualification remains a later, separate gate.

## Stop conditions

Stop rather than approximate if the implementation cannot retain all
ancestor/root descriptors, needs to reopen an entry by absolute path, cannot
confirm exact child exit and descriptor cleanup, requires the native layer to
parse plans, or introduces another journal, store, broker, runtime compiler,
download, filesystem fallback or user-selected executable.

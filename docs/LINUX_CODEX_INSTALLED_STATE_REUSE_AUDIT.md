# Linux Codex installed-state reuse audit

Source inspection: 2026-09-23. This is supporting evidence for
[`PROTECTED_LINUX_CODEX_OUTER_INSTALLER_PLAN.md`](PROTECTED_LINUX_CODEX_OUTER_INSTALLER_PLAN.md),
not a second build queue or a successful installation record.

## Result

The existing bridge, signing implementation, permission checks, journals and
Codex session can be reused. They cannot yet be joined into a protected Linux
installation simply by passing paths and callbacks to a new TypeScript factory.
The missing work is the Linux host that keeps ownership of the installed files
and credentials throughout their use. No new always-refusing wrapper was added
for this audit; the existing LCOI-1 refusal remains the boundary.

This finding is about the current implementation and its accepted custody
contract, not a claim that Linux cannot run Codex. It also does not require a
second controller database: the SQLite files below are existing worker recovery
and security journals; PostgreSQL remains installation authority.

## Code inspected and reuse decisions

| Existing implementation | Reuse | Missing property |
| --- | --- | --- |
| `src/node-bridge/private-native-configuration.ts`, `validatePrivateNativeStatePaths` | Owner, mode, realpath, hard-link, distinct-file and sidecar validation rules | Validation finishes before constructors reopen database filenames. It explicitly disclaims protection from same-user/admin changes. It is a Hermes composition, not an installed Linux verifier. |
| `src/node-bridge/private-codex-configuration.ts` | Ordered host/acquisition/journal cleanup and Codex initial/recovery composition | It similarly checks paths, then constructs journals by filename. Supplied authority and acquisition ports do not prove installation provenance. |
| `src/node-bridge/journal.ts`, `SqliteBridgeJournal` | Shared message/replay semantics, migrations and transaction rules | `new DatabaseSync(path)` opens the database by name and enables WAL. A retained descriptor for the main file alone does not protect later WAL/SHM operations. |
| `src/node-policy/v1/persistent-security-state.ts` | Separate security-artifact and high-water stores and their existing schema | Both databases open by filename and use WAL; their identities and sidecars require the same host protection. |
| `src/harness/codex-v1/start-journal.ts` | Durable execution-start and recovery semantics | Its database also opens by filename, with DELETE journaling. Protecting only WAL is insufficient; rollback journal operations matter too. |
| `src/node-policy/v1/private-key-store-factory.ts`, `encrypted-file-key-store.ts` | Existing Linux encrypted-file provider, authenticated envelope, unlock/lock/dispose lifecycle and descriptor unwrap source | Provider selection does not establish installation authority. File loaders reopen names; a caller-supplied descriptor number does not prove who supplied its bytes. The installer must own and bind the envelope and independent unwrap source. |
| `src/node-policy/v1/pinned-approval-trust.ts` | Owner approval pin validation against the security store | Pin bytes and the store must come from the same verified installation, rather than an arbitrary caller object. |
| `src/node-bridge/codex-native-process.ts` | Existing Linux executable acquisition and bounded process cleanup | Holding an executable descriptor does not establish custody of configuration, keys or SQLite files. Its Linux launch mechanism is not an installed-state verifier. |
| `native/installed-configuration-v1.c`, `native/installation-journal-session-v1.c` and their TypeScript hosts | Bounded framing, descriptor-relative path walk, identity checks and cleanup design | Both deliberately require macOS. The configuration helper uses macOS ACL APIs and `F_GETPATH`; the installation journal helper handles its own records, not the SQLite worker stores. Neither is a Linux SQLite adapter. |
| `src/node-bridge/private-codex-installed-node-entry.ts` | Current-admission exchange and one-use session capability | It explicitly borrows already-created live resources; it cannot establish their installed provenance. |

## Smallest remaining implementation packages

1. **Choose and prove Linux file custody before constructing the owner.** Reuse
   the existing schemas and journal operations. Evaluate a supported SQLite
   binding/host that can maintain the required directory and file protections,
   or an independently reviewed OS isolation arrangement that makes existing
   pathname opens meet that contract. This choice is unresolved. Do not assume
   an `O_NOFOLLOW` check or `/proc/self/fd/N` filename solves all SQLite sidecar
   behavior. Do not write a custom SQLite virtual filesystem before evaluating
   maintained implementations and the isolation alternative. A Linux test host
   is required to validate the selected mechanism; macOS tests cannot prove it.
2. **Bind installation and key inputs to that host.** Read and retain the
   release-bound manifest/configuration through the verified host; match
   installation, release, tenant, node, enrollment, profile, workspace and key
   reference. Reuse the encrypted-file key implementation. Source and own its
   unwrap channel separately from the encrypted envelope; bound reads, prevent
   descriptor reuse and clear temporary bytes. No model-controlled factory or
   configuration field may designate its own verifier.
3. **Assemble existing resources once.** Construct the shared bridge journal,
   distinct security databases, start/result journals and approval pins from
   that verified owner. Unlock the key before issuing the one-use bridge-owner
   factory. Close in reverse order after draining work. On partial open or
   uncertain cleanup, preserve recovery data and return a bounded failure.
4. **Mount the existing delivery path.** Reuse the completed bridge exchange,
   remote receipt ingress and controller session ingress. Wire the resulting
   owner into the protected installed entry. No new scheduler, task store,
   broker or permission system is needed.

The first package is a source/architecture decision for maintainers, not an
owner authentication step. Asking the owner to approve a terminal command would
not fill the missing implementation. Any later live installation remains a
separate activation operation.

## Evidence required before LCOI-1 can succeed

Use disposable files on Linux and the selected real storage mechanism to prove
directory replacement, symlink/hard-link substitution, changed ownership or
permissions, database replacement between validation and open, and sidecar
replacement/creation cannot redirect reads or writes. Include changes while a
session is running, restart recovery, wrong installation/key bindings, locked
keys, interrupted opening, and cleanup failure. A claimed `verified` flag, mock
callback, matching filename or passed schema validation is not this evidence.

Keep threat claims precise: current private-directory checks do not contain an
arbitrary compromised same-UID process or root. Either the chosen mechanism
establishes the stronger required isolation, or an explicit architecture review
must revise that requirement and document its consequences. A new constructor
must not silently weaken it.

This audit read source only. No installed files, credentials, databases,
services, processes, network connections or Linux hosts were opened or changed.

# Linux Codex SQLite custody candidates

Research date: 2026-09-23; qualification selection recorded 2026-09-24. Supporting research for
[the installed-state reuse audit](LINUX_CODEX_INSTALLED_STATE_REUSE_AUDIT.md)
and [LCOI-1](PROTECTED_LINUX_CODEX_OUTER_INSTALLER_PLAN.md). Candidate 1 is
selected only as the next disposable Linux qualification path; it is not an
accepted production security contract, implementation, installation, or Linux
qualification.

## Qualification selection

Candidate 1 is the sole path to evaluate first: **a separate trusted Node state
process, using the existing Node SQLite stores inside an OS-protected directory**.
Use maintained systemd/Linux isolation facilities rather than writing a SQLite
filesystem implementation. Candidates 2 and 3 are not parallel build work and
need a new decision if this qualification demonstrates a specific unmet
requirement. The repository has no qualified Linux arrangement yet, and LCOI-1
must continue to refuse.

The custodian needs its own service identity, distinct from Codex and every
untrusted task process. A private directory owned by the same account that
runs arbitrary task commands is insufficient. The release-bound supervisor
must own the identity transition: merely comparing different user IDs in a
configuration object is not isolation. Qualification must prove that groups,
ACLs, capabilities, inherited descriptors, service-manager overrides, and
identity reuse across stop/restart cannot bridge the boundary. Nor does a
filesystem namespace alone stop another process outside that namespace
modifying the backing files. No candidate here protects against a compromised
kernel, host administrator, or arbitrary code already executing as the trusted
custodian. This is a qualification target, not a weakened custody claim.

## Repository fit

The inspected current sources open database filenames after validation:

- `src/node-bridge/journal.ts`: `SqliteBridgeJournal`, WAL mode.
- `src/node-policy/v1/persistent-security-state.ts`: separate artifact and
  high-water databases, both WAL mode.
- `src/harness/codex-v1/start-journal.ts`: DELETE journaling.
- `src/node-bridge/private-native-configuration.ts`: owner, permissions,
  realpath, link-count and sidecar checks, explicitly excluding same-UID/admin
  containment.

SQLite creates and revisits WAL/SHM files, and rollback recovery uses a journal.
Protect the directory and complete lifecycle, not just the first main-file
open. WAL requires local-host coordination and is unsuitable for sharing this
state through a network filesystem. Each worker keeps its own local recovery
state; PostgreSQL remains controller authority. See the upstream
[WAL lifecycle](https://www.sqlite.org/wal.html).

## Three candidates

| Candidate | Maintained reuse and license | Fit and unresolved work |
| --- | --- | --- |
| **1. systemd-managed trusted Node state process** | Existing `node:sqlite` stores; Node is MIT with bundled third-party notices, SQLite is public domain. systemd is LGPL-2.1-or-later with stated exceptions. | Best reuse of existing transactions and schemas. Put the entire state directory behind a distinct service identity and protect its ancestors. Task execution must be outside that identity and cannot inherit state descriptors. A trusted launch boundary and bounded communication still require implementation and review. |
| **2. APSW Python host with VFS support** | Maintained APSW exposes SQLite VFS registration and file operations. Its license offers the displayed permissive terms or any OSI-approved license; SQLite is public domain. | Concrete maintained binding with filesystem hooks, but introduces Python and a process/API migration. WAL shared-memory operations can be inherited from the underlying VFS; overriding `xOpen` alone does not establish control of every SHM operation. No ready-made custody implementation was established in this bounded research. Do not select solely because VFS hooks exist. |
| **3. Native SQLite C host** | SQLite's maintained C VFS and file-method interfaces, public domain; Linux descriptor-relative opening through `openat2`. New host code would need repository licensing and release review. | Maximum control, largest implementation and verification burden. A custom VFS must cover open/delete/access, locking, synchronization, shared-memory and crash semantics, not only main-file descriptors. A native host using the ordinary VFS still needs candidate 1's directory isolation. Reserve for requirements that isolation demonstrably cannot meet. |

Source evidence: [Node API](https://nodejs.org/api/sqlite.html),
[Node license and notices](https://raw.githubusercontent.com/nodejs/node/main/LICENSE),
[systemd license statement](https://raw.githubusercontent.com/systemd/systemd/main/README),
[APSW VFS and inherited WAL methods](https://rogerbinns.github.io/apsw/vfs.html),
[APSW license](https://raw.githubusercontent.com/rogerbinns/apsw/master/LICENSE),
[SQLite copyright](https://www.sqlite.org/copyright.html),
[SQLite VFS](https://sqlite.org/c3ref/vfs.html),
[SQLite file methods](https://sqlite.org/c3ref/io_methods.html),
and [Linux openat2](https://man7.org/linux/man-pages/man2/openat2.2.html).
These are upstream moving references, not a pinned dependency approval.
The inspected Node API does not document a public VFS-registration or
preopened-file-descriptor constructor; do not infer one from pathname support.

## Candidate 1 qualification design

systemd provides `User=`, persistent `StateDirectory=`, explicit
`StateDirectoryMode=`, and filesystem restrictions including
`ProtectSystem=` and `InaccessiblePaths=`. State directories survive ordinary
service stops; their default mode is not the required private mode. Its
documentation also describes ownership adjustment of existing directories:
installation must reject unexpected pre-existing state before allowing a
manager to normalize it. These are mechanisms, not a complete safe unit file.
See the maintained [systemd execution documentation source](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml).

The proposed integration must prove the following with disposable Linux state:

1. Acquire and verify the installation root and every relevant ancestor before
   database construction. Reject symlinks, hard links, aliases, wrong ownership,
   unexpected modes and untrusted pre-existing sidecars. Hold the protection
   through opening, normal use, checkpointing, close, downtime and restart.
2. Run only trusted state code as the custodian. Keep Codex under a different
   identity with no state-directory access, inherited database/directory
   descriptors, process-inspection access to the custodian, or ability to change
   service configuration. Do not give the custodian arbitrary task execution.
   Design the required trusted launcher explicitly; the current launcher is not
   proof that this separation exists.
3. Reuse current concrete journal/security objects inside that process. Expose
   only bounded existing protocol operations, never arbitrary SQL, file paths,
   descriptors or key bytes. Bind the process and channel to the exact release
   and installation before issuing the existing one-use entry capability.
4. Attack main, WAL, SHM and rollback-journal paths before/during opening,
   checkpoint, close and restart. Include ancestor replacement, permission
   changes, hard links and sidecar precreation. Require prevention, not merely
   detection after redirected I/O. A hostile task process must fail these
   attacks; document separately the trusted-administrator boundary.
5. Exercise crash recovery, interrupted acquisition, disk-full and cleanup
   uncertainty. Preserve recovery files and permanent refusal on uncertainty.
   Verify that WAL/SHM recreation is legitimate SQLite activity inside the
   protected directory, not permission to substitute an unrelated file.

For this selected qualification target, controlled SQLite WAL/SHM/rollback
sidecar recreation is allowed only inside the protected state domain and only
by the reviewed lifecycle. Requiring one immutable sidecar inode forever would
conflict with normal SQLite lifecycle. Qualification must prove an untrusted
identity cannot exploit this allowance to substitute a file. This is not
evidence that the current path-based stores satisfy the requirement. Pin the
supported Linux, systemd, Node and embedded SQLite versions before any
implementation qualification.

## Evidence boundary

This pass inspected repository sources and public upstream documentation only.
The GitHub CLI could not reach its API, so live issue/PR state was not verified.
No dependencies were downloaded or installed, no credentials or installed state
were read, and no Linux host, service or database was opened. The only proposed
repository change is this research document. No candidate is marked qualified.

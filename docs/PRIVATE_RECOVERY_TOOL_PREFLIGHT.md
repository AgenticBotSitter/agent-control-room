# Recovery tool preflight and remaining host work

`openPrivateRecoveryToolPreflightV1` performs the concrete read-only file check
needed before supplying the existing recovery rehearsal adapter with a native
host. It reads eight fixed retained PostgreSQL release files and three exact
executable pins, retaining their open file descriptors until explicit close.
Each reinspection hashes the held bytes and checks that the named files still
have their original identity, permissions and timestamps. Release directories
must be owner-only; release files must be owner-only regular files with one link.
Executable files may be root-owned or owner-owned, but cannot be writable by
other users. Setuid, setgid and sticky bits are refused for every executable,
release file and held release directory. Symlinks and substitutions are refused. Input data is captured
before the first await, without invoking accessors or Proxy traps.

The pins are caller-supplied inputs; this preflight has no accepted release or
authority evidence authenticating their provenance. Its counts say only that
files match those supplied pins, and `pinProvenanceVerified` is always false.
It does not echo the asserted release/request digests as verified evidence.
`pin_provenance_missing` remains an explicit activation blocker.

This is an intentionally **read-only preflight**, not the full session host and
not installation-readiness evidence. It imports or runs no retained tool, reads
no password, contacts no database and writes no files. It returns no descriptors,
private paths, tool arguments or database identities. Closing it verifies only
the retirement of its own read handles. It does not retire a database or claim
that a backup exists. Tests use inert files in disposable temporary directories.
The production mode predicate is tested for setuid, setgid and sticky bits on
files and directories, including full file-type bits. Physical fixture cases
explicitly skip when the host filesystem strips a requested bit; they are not
reported as proving rejection of a bit the fixture never retained.

## Code reused and its boundaries

The selected files are the existing `backup-database.mjs`,
`restore-database.mjs`, `restore-identity.mjs`, `evidence.mjs`,
`apply-migrations.mjs`, migration ledger, dependency manifest and production
role SQL. The existing host-value capture helpers reject behavioral input.
The future host must continue using the accepted rehearsal adapter and its
existing database/artifact evidence formats.

Reading and pinning the dependency **manifest** does not verify its file list or
all transitive runtime dependency bytes. Holding a regular-file descriptor does
not make a subsequent spawn-by-path select that descriptor. This preflight
therefore always returns `readyForExecution: false`,
`dependencyContentsVerified: false`, and `extendedAclVerified: false`.
The deadline is cooperative between bounded regular-file reads; it does not
pretend to cancel a kernel filesystem call. Each inspection is serialized with
close, and cleanup remains available after cancellation or expiration.

## Concrete blockers before connecting the rehearsal adapter

The activation blocker list also explicitly requires authenticated pin
provenance, private source credentials and a protected backup destination.
Those are not established by matching bytes to caller-provided hashes. They
must come from the accepted installation/release authority and protected
operator configuration before a native recovery host can operate.

1. **Subprocess and connection custody.** The retained database exports currently
   create their own connections and invoke `execFile` internally. The native
   host must own the complete tool process group and bound/retire all database
   sessions on cancellation, output loss, parent loss and timeouts. An abort
   wrapper around the exported promise is not sufficient. It must verify the
   dependency closure and kernel-selected executables, and check extended ACLs.
2. **Isolated restore cluster.** Restore applies role SQL, creates roles, grants
   memberships and changes database ownership. A second database on the live
   shared PostgreSQL cluster is insufficient. Observe a separately provisioned
   disposable cluster, its role state and empty restore/artifact destinations.
   Reobserve immediately before restoring. No automatic cluster provision is
   included in this package.
3. **Consistent backup and actual artifact bytes.** Hold the quiesced source and
   exact protected backup inventory. Reuse the existing exported database
   snapshot. Hash the restored artifact bytes; copying inventory metadata alone
   cannot satisfy recovery.
4. **Restricted login checks.** Connect with the actual restored application and
   scheduler logins; demonstrate permitted reads and denied forbidden writes
   and privilege changes. Observations must be transaction-contained and must
   come from the restored target rather than copied metadata.
5. **Certain cleanup.** Observe every subprocess exit and connection retirement,
   account for the disposable cluster and restore directory, and preserve the
   original source and retained backup. An uncertain exit yields no proof and
   no automatic retry.

These requirements fit the already accepted adapter ports. No second scheduler,
database authority, backup format or new owner approval process is introduced.

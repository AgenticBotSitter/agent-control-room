# macOS protected installed-configuration native host

**Status:** source-complete and tested only with disposable paths. No owner
installation root was written, no service was started, and no worker,
credential, database, or network endpoint was contacted. A real publication
remains an attached-owner operation after independent review and native host
qualification.

## Fixed scope

`native/installed-configuration-v1.c` has exactly two operations under protocol
`ACRCFG1`:

1. publish one new standard macOS protected root; and
2. verify one already-open descriptor for the existing installed-configuration
   custody reader.

It is not a general filesystem helper or command runner. It accepts no command,
argument vector, environment selection, replacement path, cleanup path, or
arbitrary output. The Node host invokes it with no arguments, a fixed working
directory and a minimal fixed environment. Standard error or any malformed,
oversized, late, partial, or unsuccessful response makes the result uncertain.
Replies contain only bounded numeric identities and modes; configuration and
manifest bytes never enter output.

## Atomic publication

The only production destination is:

```text
/Users/<owner>/Library/Application Support/Agent Control Room/Protected
```

The helper opens every existing ancestor one component at a time with
no-follow semantics and retains those descriptors. It requires the final root
and its fixed sibling staging name to be absent. It then creates the complete
`0700` root, `0700` `installation-journal`, `0600` `operator.json`, and `0600`
`installed-manifest.json` below that private sibling. Each file is written,
synced, read back from the same descriptor, and rechecked for exact identity,
owner, size, mode, one link, and no extended ACL. The complete directory is
made visible with one no-replace `renameatx_np(..., RENAME_EXCL)` and its parent
is synced.

Ordinary macOS ancestors may have either no extended ACL or exactly the
standard non-inherited `everyone deny delete` entry. No other entry, permission,
principal, inheritance flag, or second entry is accepted. The final protected
root and every protected file/directory remain ACL-free. Descriptor evidence
truthfully reports when that one reviewed ancestor ACL is present.

An existing final root is never replaced, repaired, deleted, or merged. A
crash before the rename can leave only the fixed private sibling for owner
inspection; it cannot expose a partial final configuration. A crash or lost
reply after the rename is uncertain and must not be retried as a new
publication.

## Descriptor verification

The reader continues to open files and directories itself. It passes the held
descriptor as descriptor 3. The helper obtains the kernel path for that same
descriptor, opens and retains its named ancestor chain without following
links, and verifies exact device, inode, owner, mode, type, file link count,
and the ACL policy above before returning path-free evidence. Root-owned safe
ancestors are permitted; the final protected root is ACL-free, and the
manifest, configuration, and journal must belong to the configured non-root
owner and be ACL-free. The reader still performs its own
exact length, digest, timestamp, link, and before/after identity checks.

## Release and process custody

`scripts/build-installed-configuration-native.mjs` compiles only the reviewed
source with the fixed Apple compiler flags and packages the exact repository
`LICENSE` and `NOTICE` in a deterministic archive. The sidecar verifier binds
the release version, sidecar manifest, archive, artifact manifest, executable,
source, compiler, SDK, platform, architecture, file names, modes, sizes, and
digests. The build explicitly sets the archive, artifact manifest, and checksum
list to `0644`, including when the caller uses a restrictive umask.

Staging requires those release and digest values again plus a compatible macOS
host before it creates a fresh private directory. The runtime host rereads and
hashes the executable, copies the captured bytes to another fresh private
staging identity, and executes only that copy. It allows one publication
attempt, serializes every helper call, actively handles abort/deadline, kills
and reaps the entire fresh process group, zeroes retained private bytes, and
deletes only the exact staged identities during confirmed cleanup. It retains
unresolved helper and process-group custody after a bounded uncertain result;
cleanup refuses until close and process-group absence have been proved. Its
readiness report exposes only state and counts, never process IDs or private
material. Configuration and manifest inputs are accepted only as exact host
`Uint8Array` values and are copied before any asynchronous work.
If staging fails, the host retains the exact partial directory/file identities
whenever immediate removal cannot be proved. Cleanup remains retryable and is
confirmed only after those same identities are removed; an obstructed cleanup
does not close the host or discard custody.

## Evidence and remaining owner gate

Disposable tests compile and run the real helper with a compile-time test-root
prefix that is absent from the release build. They prove complete atomic
publication, no replacement, unsafe-ancestor and link refusal, descriptor
verification, mode/link/ACL refusal, one-use publication, bounded handling of
hang, crash, standard-error, malformed/oversized reply and surviving-child
faults, exact installation-ID grammar, restrictive-umask output modes,
before-rename and after-rename-before-reply uncertainty, composed
host-to-helper publication and custody reread, deterministic builds, exact
sidecar parsing, and release/digest binding before staging. The compile-time
test prefix maps the fixed logical production-shaped path into a disposable
tree; the release compiler flags do not define that prefix.

This evidence does not authorize a real write. Before the owner can publish the
installed configuration, the package still needs independent review, release
assembly binding, and one attached-owner qualification using the exact staged
artifact and intended owner path. An agent must not type the owner phrase,
approve a system prompt, infer owner presence, or repeat an uncertain native
attempt.

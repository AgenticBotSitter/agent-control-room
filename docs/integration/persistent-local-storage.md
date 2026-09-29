# Persistent local artifact storage

`PersistentLocalArtifactStorageV1` is an inert local byte adapter for canonical native-result artifacts. It implements both `ArtifactStoragePortV1` and `ArtifactReadPortV1`; it does not publish a result, complete a job, update metadata, start a provider, choose credentials, or create a storage directory.

## Ownership and configuration

The caller must create one empty private directory and pass its canonical absolute path to `createPersistentLocalArtifactStorageV1`. The adapter captures that directory's canonical path, device, and inode. Every later operation rechecks the same identity and, on POSIX systems, requires that neither group nor other users have permissions.

All limits are explicit:

- `maximumArtifacts` bounds directory inventory work and object count.
- `maximumFileBytes` is the per-result logical-byte limit and cannot exceed the native-result contract limit of 65,536 bytes.
- `maximumTotalBytes` bounds the sum of logical result bytes.
- `operationTimeoutMs` bounds a complete adapter operation, including durability synchronization. A timeout makes the adapter uncertain and it returns no bytes or receipt.

No production root, default path, URL, environment variable, or credential is selected here. Deployment configuration and backup/restore integration remain separate work.

## Stored form and replay

Only canonical `artifact:native:<64 lowercase hex characters>` and
`artifact:result:<64 lowercase hex characters>` identities are accepted. The
second form also holds an exact local Hermes terminal-stage envelope whose
identifier is derived from an already accepted delivery. Caller-supplied
paths, URLs, traversal components, absolute paths, and either path separator
are therefore invalid. The physical filename is a SHA-256 mapping of the
artifact identity; the caller never supplies or receives it.

Each file is a create-once envelope containing the exact artifact identity, content hash, logical size, and result bytes. Reads validate the envelope, recompute the hash and size with `checkedResultBytes`, and compare the opened file with the directory entry before returning a copy. The returned locator is opaque and contains no root or physical path.

An exact replay returns the same descriptor. Different bytes for the same identity return `storage_conflict`. A new adapter over the unchanged root can read and exactly replay the durable object. The adapter never replaces an existing artifact.

## Failure and custody rules

Writes use a create-exclusive lock, a private pending file, file synchronization, create-once linking, directory synchronization, and exact readback. Only a lock acquired by the current operation is removed. Before lock cleanup starts, a new artifact has already been linked, the link and pending-file retirement have each been directory-synchronized, and the exact stored envelope has been read back. That is the artifact certainty boundary. A later lock-close, lock-unlink, or final directory-sync failure retires the current adapter but returns the already-proven descriptor: it cannot make the artifact bytes ambiguous. If the lock survives or reappears after a crash, it durably blocks a new adapter for manual reconciliation; if it does not survive, a new adapter validates and exactly replays the artifact. This avoids depending on a post-failure marker whose own creation or synchronization could fail.

Before that certainty boundary, any filesystem-operation failure, cancellation, or timeout makes the adapter terminally uncertain: it returns no descriptor, refuses every subsequent call, and preserves its lock and any pending evidence. A stale lock, pending file, foreign entry, symlink, hardlink, changed root, changed file identity, mutation, truncation, or malformed envelope also fails closed as `storage_ambiguous`. The adapter does not repair or delete uncertain files. Operators must preserve the root and reconcile uncertain storage outside this adapter. Restarting the adapter is not permission to recover a lock or retry a write.

The tests use actual filesystem operations in disposable private directories. A separate test-only factory gates those same operations to inject failures, cancellation, and timeout at write, sync, create-once-link, and cleanup boundaries; production construction has no injection argument. Tests cover restart replay, concurrent conflict, quotas, cancellation/deadline refusal, terminal uncertainty and subsequent-call refusal, lock-unlink failure before and after mutation, final directory-sync failure before and after mutation, the two crash-visible lock outcomes, mutation and truncation, traversal forms, symlink and hardlink custody, root substitution, and preservation of stale or foreign evidence. These tests are adapter evidence only; they do not qualify a production filesystem, backup process, or complete result-publication path.

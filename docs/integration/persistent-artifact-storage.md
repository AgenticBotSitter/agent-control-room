# Persistent artifact storage composition

The trusted agent-task startup can now open one accepted local artifact adapter and bind that exact object to every configured result writer and reader. This composes the previously accepted `PersistentLocalArtifactStorageV1`; it does not introduce another filesystem implementation or an object-storage service.

## Operator input

`PrivateTaskStartupConfiguration.artifactStorage` is server-only configuration with two parts:

- `local` contains the canonical absolute path of an existing private directory plus explicit object, file-byte, total-byte and two-second-or-shorter operation limits.
- `inventory` contains the release, database schema and storage-namespace identities required by the accepted artifact backup inventory contract. `storageNamespaceDigest` must equal `privateArtifactStorageNamespaceDigestV1(storageNamespace, rootPath)`, which binds the trusted namespace to the selected canonical path without returning that path.

Artifact storage is accepted only with the complete result composition: web result reading, quality processing, a separate result database and native evidence receiving must all be configured for the local storage class. Startup replaces their supplied byte ports with one process-owned adapter. The browser retains only a read capability and receives opaque artifact locators, never the directory path.

The standalone website-only bootstrap has no artifact-storage field or factory. It therefore performs no artifact filesystem operation. Merely constructing either host is also inert.

## Startup and restart gate

Agent-task startup performs these checks before it can report ready or bind a listener:

1. Capture all path, limit, timeout and inventory values before asynchronous work.
2. Open the existing directory through the accepted adapter. Canonical path, private permissions, directory identity, stale lock, pending file and foreign-entry checks remain owned by that adapter.
3. After the restricted evidence database passes its existing role/schema checks, read a bounded joined view of every result receipt, artifact manifest and byte-write reservation for the configured tenant.
4. Require exactly one complete, committed and internally matching receipt/manifest/reservation binding for every artifact. Then read and hash the exact bytes through the shared adapter.
5. Produce the sorted `ArtifactBackupInventoryV1` value that the restore package consumes. This is inventory input only; it does not claim a backup or restore exists.

A missing object, extra or duplicate binding, wrong tenant/project/job/attempt/run, changed content, truncated envelope, unsupported storage class, incomplete reservation, cancellation or over-limit inventory refuses startup. The composition never repairs, deletes or retries uncertain storage. Existing startup cleanup still closes any database, worker, native service or listener acquired before a later failure.

On a clean restart, a new adapter opens the same private directory and validates each stored object against the saved database binding before readiness. A different or empty directory cannot impersonate the configured namespace once the database contains results: its required bytes are missing and startup refuses.

## Backup boundary

The returned server-only startup handle exposes the one shared byte port, the immutable startup inventory and a bounded `captureInventory` operation over the still-owned restricted result database. The reviewed Codex publication can therefore receive the same storage object, while the backup/restore package can request a current exact inventory rather than reusing a stale startup snapshot. Inventory capture refuses after shutdown or database loss. The handle grants no browser path access, backup authority, completion status, retry authority or cleanup authority. R2 remains outside this package.

The automated tests use only owned temporary directories and injected database rows. They cover one-instance binding, exact inventory material, restart replay, wrong or missing bindings, corruption, stale locks and cancellation. They perform no production filesystem, database, network, provider or deployment action.

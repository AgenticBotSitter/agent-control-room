# Retained backup and restore

Status: effect-free package implemented; production storage and PostgreSQL integration are not qualified.

This package uses an operator-installed `restic` 0.19.1 executable to retain one exact set containing:

- a database dump already verified by the database adapter;
- the accepted artifact inventory and its exact artifact bytes; and
- the independently retained rollback checkpoint that belongs to the same release.

It does not create a PostgreSQL dump, interpret PostgreSQL ownership, update the checkpoint, configure a remote repository, or delete a snapshot. Issue #63 must supply the real `VerifiedDatabaseDumpPortV1`. Until that adapter exists and passes its own review, this is not a production backup path.

## Security boundary

Run backup and restore as a dedicated operator-owned process, not inside the Control Room web or worker service. The normal application receives no repository password, backend credential, binding key, maintenance right, or callable backup interface.

The operator supplies absolute canonical paths to:

- the exact `restic` executable (the runner refuses any version except 0.19.1);
- a private `--repository-file`;
- a private `--password-file`;
- a separate 32-byte binding key file; and
- a private state directory used for authenticated bindings and recovery journals.

Secret and data files must be owner-only regular files, without symlinks. The executable may be read or executed by others but may not be group- or world-writable. Arguments contain file paths, never secret values. Child processes receive a minimal environment. Backend credentials that restic requires must be injected by the dedicated supervisor or a separately reviewed descriptor-based adapter; they must not be placed in application configuration or command arguments.

Keep the binding key and state directory outside the protected database and outside the repository's failure domain. Losing them makes a snapshot untrusted. Treat a binding mismatch, duplicate matching snapshots, an interrupted write, or an unknown snapshot identity as an operator incident; do not retry automatically.

## Backup lifecycle

1. Obtain the opaque verified-dump binding from the reviewed #63 adapter.
2. Supply the exact artifact inventory/bytes and external checkpoint for that binding.
3. The runner validates identities and bytes, copies them into an owner-only staging directory, and validates the copied bytes again.
4. It writes a durable pending operation record, calls `restic backup`, and reconciles the returned snapshot with one exact digest tag.
5. It writes an authenticated snapshot binding and commits the operation record. Its owned staging directory is removed.

Repeating the exact request returns the committed snapshot without another backup. A changed dump, inventory, checkpoint, repository selection, or schema identity creates a different binding. An interrupted or ambiguous request remains uncertain and cannot silently produce another snapshot.

## Restore lifecycle

1. Choose a new, absent directory beneath an owner-only parent. Existing targets are refused.
2. The runner authenticates the retained binding and confirms the repository selection.
3. It runs `restic check --read-data`, then restores exactly the bound snapshot.
4. It verifies the canonical manifest, delegates artifact-inventory comparison to the existing artifact contract, checks every artifact byte and the checkpoint digest, and delegates the database dump to #63.
5. It returns a verification record which explicitly says it did not advance or reset the checkpoint and deleted no data.

A failed restore target is retained for diagnosis and is never reused automatically. Promotion of verified restored data is a separate operator-controlled action.

## Recovery and maintenance

- Lost reply after a committed backup: repeat the exact request; it reconciles the one bound snapshot.
- Pending/uncertain record or more than one matching snapshot: stop and investigate. Do not remove the journal or binding just to retry.
- Failed integrity check or restored mismatch: quarantine the new restore directory and repository; do not change the external checkpoint.
- Delete, forget, and prune are deliberately absent. They require a separate offline maintenance identity and procedure.

The temporary test suite uses only a fake executable and local disposable repository. It performs no network, database, R2, credential-store, service, or production action.

## Remote repository boundary

Restic supports S3-compatible repositories, but this package has not qualified any provider, endpoint, transport, retention policy, or credential set. In particular, Cloudflare R2 is not claimed append-only. Before using it, independently test upload, interrupted upload, listing, exact restore, integrity checking, credential separation, denial of delete to the backup identity, and recovery using the restore identity.

The project does not bundle restic. Upstream revision and license evidence are recorded in `examples/backup/restic-provenance.json`. If a future distribution bundles a binary, its platform checksum and BSD-2-Clause notice must be added to the release license inventory.

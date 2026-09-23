# Pre-database installation plan journal

The installation plan cannot initially live in PostgreSQL because creating,
migrating and verifying PostgreSQL is itself the third ordered installation
stage. Requiring that database to store the proof needed to reach that stage
would create a circular dependency. A browser store is also unsuitable because
it is neither owner-private nor durable enough to decide whether an interrupted
setup effect may be repeated.

`InstallationPlanFilesystemJournalV1` is the narrow bridge across that gap. It
reuses the accepted digest-only installation plan and the repository's existing
private-file rules: an operator-created canonical root, exact owner and private
permissions, exclusive creation, a private temporary file, file sync,
no-replace hard-link publication, directory sync and immutable read-back.

Each sanitized installation ID has one numbered revision file. Reading the
journal requires revisions to start at zero and remain contiguous. Every file
must contain a valid plan whose revision matches its name, and every adjacent
pair must be a legal single stage transition or legal dependency-invalidating
refresh. An exact retry returns the existing revision. Different content for an
occupied revision is a conflict.

Temporary files are never history. A crash before publication therefore cannot
create proof. If a crash occurs just after no-replace publication, a later read
can retire exactly one private temporary name only when it is the second hard
link to that same revision file **and** a private, fsynced publication witness
binds that exact temporary name and plan digest. Without that witness, an
orphan temp or unrelated link is never promoted or removed. The writer likewise removes only the exact private
temporary file it created and only while its device and inode still match. The
public append result contains only the sanitized
installation ID, revision, plan digest and inert capability flags—never the
private root path or plan evidence.

This package does **not** create the root, create a database, store credentials,
change a current-version pointer, start a service or worker, contact a network,
or grant setup authority. A later owner-only installer action supplies the
already-created protected root and advances the same journal around separately
reviewed effects.

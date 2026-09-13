# Backup integration example

`verified-database-dump-binding.example.json` documents the minimum opaque value the future #63 PostgreSQL adapter must return after independently verifying a dump. Values are illustrative digests, not production evidence.

Construct `ResticRetainedSnapshotRunnerV1` in a separate operator process and inject a reviewed `VerifiedDatabaseDumpPortV1`. The adapter must verify the requested database identity and exact dump on backup, then verify the newly restored dump on restore. The retained-backup package intentionally has no fallback implementation.

Do not paste repository passwords, S3 keys, connection strings, real host paths, or private endpoints into this directory. See `docs/operations/backup-restore.md` for the lifecycle and the remaining production gates.


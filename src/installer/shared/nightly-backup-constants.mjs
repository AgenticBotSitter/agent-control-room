// Dependency-free constants shared by bare Node operator commands and typed callers.
// Keep the implementation in the shipped shared directory: Node 22.13 has no
// TypeScript loader, and extracted releases must carry every imported module.

// A scheduled database dump may take up to 45 minutes. The daemon's outer
// shutdown deadline is derived from this bound so a working dump can finish.
export const NIGHTLY_DUMP_TIMEOUT_MS_V1 = 45 * 60 * 1000;

// The dump producer, scheduled retention reader, and operator verifier must
// agree on the manifest schema that binds one completed backup generation.
export const BACKUP_MANIFEST_SCHEMA_V1 = "control-room.verified-database-backup/v1";

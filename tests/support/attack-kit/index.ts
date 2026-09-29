// Shared attack-test kit for tests.
//
// Every export here is a test helper, never production code. Import from this
// one entry point so a test gets a reviewed set of harnesses rather than a
// hand-rolled cluster, pool or identity per file.

export {
  AttackKitPortError,
  PortOccupiedError,
  REPOSITORY_DATABASE_NAME,
  REPOSITORY_ROOT,
  CLUSTER_REGISTRY_NAME,
  NAMED_ROLES,
  ROLE_LOGINS,
  assertClusterDestroyed,
  assertPortAvailable,
  disposableRunDirectories,
  newSharedMemorySegments,
  portIsOccupied,
  readClusterRegistry,
  realPostgresSkipMessage,
  requiresRealPostgres,
  resolvePgBin,
  sharedMemoryLeaks,
  sharedMemorySegments,
  shutdownLadder,
  shortSocketDirectories,
  socketClaimed,
  withRealPostgres,
} from "./real-postgres";
export type {
  AttackRole,
  ConnectionOptions,
  RealPostgres,
  SharedMemoryLeak,
  SharedMemorySegment,
  ShutdownAction,
  ShutdownLadderOptions,
  ShutdownLadderResult,
  ShutdownStep,
  WithRealPostgresBody,
  WithRealPostgresFullOptions,
  WithRealPostgresOptions,
  WithRealPostgresResult,
} from "./real-postgres";

export {
  ConcurrencyTimeoutError,
  ConcurrentReadRaceError,
  NoWritesSucceededError,
  concurrently,
  concurrentWriters,
  exhaustPool,
} from "./concurrency";
export type {
  ConcurrentWritersOptions,
  ConcurrentWritersResult,
  ExhaustPoolOptions,
  ExhaustPoolResult,
  PoolLike,
} from "./concurrency";

export { expectNoLeak, twoOwners, twoSessions, twoTenants } from "./identities";
export type {
  AttackIdentity,
  TwoOwners,
  TwoOwnersOptions,
  TwoSessions,
  TwoSessionsOptions,
  TwoTenants,
  TwoTenantsOptions,
} from "./identities";

export {
  assertGuardBites,
  ATTACK_KIT_ROOT,
  DirtyTreeError,
  fileExists,
  GuardDidNotBiteError,
  InvalidTestCommandError,
  MutationTimeoutError,
  reapKitClusters,
  tokenizeCommand,
} from "./mutation";
export type { AssertGuardBitesOptions, GuardBitesResult } from "./mutation";

export { isPrivilegeDenied, privilegeMatrix, roleCan, roleCannot, PrivilegeAssertionError } from "./privileges";
export type { PrivilegeMatrixRow, PrivilegeOptions } from "./privileges";

// The GATE is `securityDefinerAuditLive`, read from a real catalog.
// `securityDefinerAudit` is a local hint over migration text, not a gate: it
// cannot be made sound, and nothing in CI runs it.
export {
  ALLOWLIST_MAX_DAYS,
  allowlistKey,
  assertSearchPathPinned,
  loadSearchPathAllowlist,
  parseGucList,
  parseIsoDate,
  parseSearchPath,
  proconfigSearchPath,
  searchPathEndsInPgTemp,
  SearchPathAllowlistError,
  securityDefinerAudit,
  securityDefinerAuditLive,
  splitSqlStatements,
  staleAllowlistEntries,
  stripSqlComments,
  UnpinnedSearchPathError,
} from "./search-path-audit";
export type {
  CatalogAuditOptions,
  FunctionFinding,
  GucElement,
  LoadedSearchPathAllowlist,
  PrivilegedKind,
  SearchPathAllowlistEntry,
  SecurityDefinerAuditOptions,
  SecurityDefinerAuditResult,
} from "./search-path-audit";

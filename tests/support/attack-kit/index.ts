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
  NAMED_ROLES,
  ROLE_LOGINS,
  assertClusterDestroyed,
  assertPortAvailable,
  disposableRunDirectories,
  portIsOccupied,
  realPostgresSkipMessage,
  requiresRealPostgres,
  resolvePgBin,
  withRealPostgres,
} from "./real-postgres";
export type {
  AttackRole,
  ConnectionOptions,
  RealPostgres,
  WithRealPostgresBody,
  WithRealPostgresFullOptions,
  WithRealPostgresOptions,
  WithRealPostgresResult,
} from "./real-postgres";

export {
  ConcurrencyTimeoutError,
  ConcurrentReadRaceError,
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
  tokenizeCommand,
} from "./mutation";
export type { AssertGuardBitesOptions, GuardBitesResult } from "./mutation";

export { isPrivilegeDenied, privilegeMatrix, roleCan, roleCannot, PrivilegeAssertionError } from "./privileges";
export type { PrivilegeMatrixRow, PrivilegeOptions } from "./privileges";

export {
  assertSearchPathPinned,
  parseSearchPath,
  searchPathEndsInPgTemp,
  securityDefinerAudit,
  securityDefinerAuditLive,
  UnpinnedSearchPathError,
} from "./search-path-audit";
export type { FunctionFinding, SecurityDefinerAuditResult } from "./search-path-audit";

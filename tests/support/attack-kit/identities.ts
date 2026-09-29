// Identity fixtures for isolation tests.
//
// The gap these close: a test that only ever authenticates as one identity
// cannot tell a working check from one that returns the right answer for the
// wrong reason. Two independent identities make every "denied" assertion
// meaningful, because the denied case and the permitted case differ only in
// the identity.

import { sha256Digest } from "../../../src/security/canonical-digest";

/**
 * The identity shape `createAccessVerifier` returns (`VerifiedWebIdentity`),
 * restated here so the kit does not couple its fixtures to one service's
 * verifier. A field added there is a field a test must start asserting on.
 */
export interface AttackIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly verificationExpiresAt: string;
}

const segment = /^[A-Za-z0-9_-]{1,256}$/;

function identity(subject: string, token: string, atMs: number, ttlMs: number): AttackIdentity {
  if (!segment.test(subject)) throw new Error("attack_identity_subject_invalid");
  const issuedAt = new Date(atMs).toISOString();
  const expiresAt = new Date(atMs + ttlMs).toISOString();
  return Object.freeze({
    provider: "https://access.example.invalid",
    subject,
    // The token itself is a fixture constant; only its digest is ever compared.
    tokenDigest: sha256Digest({ token }),
    issuedAt,
    expiresAt,
    verificationExpiresAt: expiresAt,
  });
}

export interface TwoOwnersOptions {
  /** Fixed clock in epoch ms, so fixtures are deterministic. */
  nowMs?: number;
  sessionTtlMs?: number;
  /** Distinct scopes, e.g. project ids the two owners must not cross. */
  ownerAScope?: string;
  ownerBScope?: string;
}

export interface TwoOwners {
  readonly ownerA: AttackIdentity;
  readonly ownerB: AttackIdentity;
  readonly ownerAScope: string;
  readonly ownerBScope: string;
  /** Revoke one session the way sign-out does, so replay can be proven. */
  readonly revokeOwnerB: () => Promise<void>;
}

/**
 * Two independent authenticated owners in the SAME tenant.
 *
 * Independence is by construction, not by convention: the two identities have
 * different subjects, different token digests and different scope strings, so
 * an implementation that keys on any one of them still cannot serve the other.
 */
export function twoOwners(options: TwoOwnersOptions = {}): TwoOwners {
  const nowMs = options.nowMs ?? Date.parse("2026-09-28T12:00:00.000Z");
  const sessionTtlMs = options.sessionTtlMs ?? 3_600_000;
  return Object.freeze({
    ownerA: identity("owner-a", "attack-kit-owner-a", nowMs, sessionTtlMs),
    ownerB: identity("owner-b", "attack-kit-owner-b", nowMs, sessionTtlMs),
    ownerAScope: options.ownerAScope ?? "project:attack-kit-a",
    ownerBScope: options.ownerBScope ?? "project:attack-kit-b",
    // Placeholder: revocation is a database write, and the kit has no cluster
    // of its own. `twoSessions` takes the real revocation callback instead.
    revokeOwnerB: async () => { throw new Error("attack_kit_use_two_sessions_for_revocation"); },
  });
}

export interface TwoTenantsOptions {
  nowMs?: number;
  sessionTtlMs?: number;
  tenantA?: string;
  tenantB?: string;
  workspaceA?: string;
  workspaceB?: string;
  /** Seed a row the second tenant must never observe. */
  secretForTenantA?: string;
}

export interface TwoTenants {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly identityA: AttackIdentity;
  readonly identityB: AttackIdentity;
  /** A value that exists only under tenantA. Feed it to `expectNoLeak`. */
  readonly secretForTenantA: string;
}

/**
 * Two identities in two different tenants, each with its own workspace.
 *
 * Cross-tenant reads are the classic silent leak: a query scoped by workspace
 * but not by tenant returns the other tenant's row with a plausible shape.
 */
export function twoTenants(options: TwoTenantsOptions = {}): TwoTenants {
  const nowMs = options.nowMs ?? Date.parse("2026-09-28T12:00:00.000Z");
  const sessionTtlMs = options.sessionTtlMs ?? 3_600_000;
  const tenantA = options.tenantA ?? "tenant:attack-kit-a";
  const tenantB = options.tenantB ?? "tenant:attack-kit-b";
  return Object.freeze({
    tenantA,
    tenantB,
    workspaceA: options.workspaceA ?? "workspace:attack-kit-a",
    workspaceB: options.workspaceB ?? "workspace:attack-kit-b",
    identityA: identity("tenant-a-operator", "attack-kit-tenant-a", nowMs, sessionTtlMs),
    identityB: identity("tenant-b-operator", "attack-kit-tenant-b", nowMs, sessionTtlMs),
    secretForTenantA: options.secretForTenantA ?? "attack-kit-tenant-a-secret-value",
  });
}

export interface TwoSessionsOptions {
  nowMs?: number;
  sessionTtlMs?: number;
  /** Applies the sign-out write. Required, so a revocation test is real. */
  revoke: (session: AttackIdentity, revokedAt: string) => Promise<void>;
}

export interface TwoSessions {
  readonly first: AttackIdentity;
  readonly second: AttackIdentity;
  /** Second sign-in for the same subject, so the first can be revoked alone. */
  readonly revokeFirst: () => Promise<void>;
  readonly revokeSecond: () => Promise<void>;
}

/**
 * Two concurrent sessions for the SAME identity.
 *
 * Revoking one session must not log the other out and must not stop the other
 * from being refused: the pair only proves something if the test revokes one
 * and checks both directions.
 */
export function twoSessions(options: TwoSessionsOptions): TwoSessions {
  if (typeof options?.revoke !== "function") throw new Error("attack_kit_two_sessions_requires_revoke");
  const nowMs = options.nowMs ?? Date.parse("2026-09-28T12:00:00.000Z");
  const sessionTtlMs = options.sessionTtlMs ?? 3_600_000;
  const first = identity("shared-subject", "attack-kit-session-1", nowMs, sessionTtlMs);
  const second = identity("shared-subject", "attack-kit-session-2", nowMs, sessionTtlMs);
  const revokedAt = new Date(nowMs + 1_000).toISOString();
  return Object.freeze({
    first,
    second,
    revokeFirst: () => options.revoke(first, revokedAt),
    revokeSecond: () => options.revoke(second, revokedAt),
  });
}

const LEAK_TOKENS = /[A-Za-z0-9_-]{8,}/gu;

/** Strings that describe the response rather than being data from it. */
const IGNORED_KEYS = new Set([
  "status", "statusText", "ok", "headers", "url", "type", "durationMs", "elapsedMs", "count",
]);

function scalars(value: unknown, path: string, found: { path: string; value: string }[]): void {
  if (typeof value === "string") {
    for (const token of value.match(LEAK_TOKENS) ?? []) {
      if (token.length >= 8) found.push({ path, value: token });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scalars(item, `${path}[${index}]`, found));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (IGNORED_KEYS.has(key)) continue;
      scalars(item, path === "" ? key : `${path}.${key}`, found);
    }
  }
}

export interface NoLeakOptions {
  /** Field paths that legitimately echo the secret (e.g. an echoed request id). */
  allow?: readonly string[];
}

/**
 * Assert that a response carries nothing belonging to the other identity.
 *
 * The check is token-based rather than field-based on purpose: a leak that
 * renames a column or nests one level deeper is still a leak, and a
 * field-by-field allow-list would have to be updated every time the response
 * shape changed. Every distinct token of `dataB` is searched for anywhere in
 * the response, so the assertion survives a shape change.
 */
export function expectNoLeak(response: unknown, dataB: unknown, options: NoLeakOptions = {}): void {
  const forbidden: { path: string; value: string }[] = [];
  scalars(dataB, "", forbidden);
  const tokens = new Set(forbidden.map(entry => entry.value));
  if (tokens.size === 0) throw new Error("expect_no_leak_requires_non_trivial_data");
  const leaked: { path: string; value: string }[] = [];
  scalars(response, "", leaked);
  const allowed = new Set(options.allow ?? []);
  for (const hit of leaked) {
    if (!tokens.has(hit.value)) continue;
    if ([...allowed].some(prefix => hit.path === prefix || hit.path.startsWith(`${prefix}.`)
      || hit.path.startsWith(`${prefix}[`))) continue;
    throw new Error(`response_leaked_other_identity_data:${hit.path}:${hit.value.slice(0, 8)}`);
  }
}

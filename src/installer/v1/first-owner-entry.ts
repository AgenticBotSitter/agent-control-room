// The release's first-owner entry (`dist-vps/server/firstOwner.js`, N1).
//
// The installer (the fixed updater) cannot import release code or `pg`, so it runs
// THIS file as a child of the release's pinned Node, as the database account, at
// its `first-owner` step. Everything the transaction needs arrives on stdin as ONE
// JSON document the installer built before the step: the socket and port, the
// login (the peer map's `postgres` line), the owner identity values, `createdAt`
// and the completion-gate review key. Nothing is read from protected configuration,
// which is composed after this step and from this step's result. The secret (the
// review key) is on stdin only: never argv, environment, stdout or stderr.
//
// The output is ONE JSON line: the release transaction's receipt plus the owner
// identity read back from the row it wrote. Any failure exits non-zero with only a
// fixed refusal code on stderr; the installer then refuses and rolls back.
//
// The manifest is built by the release's own `createMacLocalFirstOwnerManifestV1`
// and the transaction is the release's own `applyMacLocalFirstOwnerV1`, which is
// idempotent by row identity: a re-run with the same request (after a kill before
// or after COMMIT) creates the missing rows or keeps every row, never a second owner.
import { isMainModuleV1 } from "../shared/is-main-module.mjs";
import { Client } from "pg";
import { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { sha256Digest } from "../../security/canonical-digest";
import { applyMacLocalFirstOwnerV1 } from "../../../scripts/mac-local/first-owner-vps.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../../../scripts/mac-local/first-owner-manifest.mjs";

export const FIRST_OWNER_REQUEST_V1 = "control-room.first-owner-request/v1";
export const FIRST_OWNER_RESULT_V1 = "control-room.first-owner-result/v1";
export const FIRST_OWNER_MAXIMUM_REQUEST_BYTES_V1 = 64 * 1024;

type Workers = Readonly<{ hermes: string; claude: string; codex: string }>;
export type FirstOwnerRequestV1 = Readonly<{
  schema: typeof FIRST_OWNER_REQUEST_V1;
  database: Readonly<{ host: string; port: number; name: string; user: "postgres" }>;
  owner: Readonly<{ tenantId: string; workspaceId: string; provider: string; subject: string; nodeBase: string;
    workers: Workers; workIntakeProjectIds: readonly string[] }>;
  createdAt: string;
  reviewKey: string;
}>;

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) refuse("first_owner_request_refused");
  return value as Record<string, unknown>;
};
const text = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/u;

/** The one request shape; anything else is refused before a connection is opened. */
export function parseFirstOwnerRequestV1(value: unknown): FirstOwnerRequestV1 {
  const request = record(value, ["schema", "database", "owner", "createdAt", "reviewKey"]);
  const database = record(request.database, ["host", "port", "name", "user"]);
  const owner = record(request.owner, ["tenantId", "workspaceId", "provider", "subject", "nodeBase", "workers",
    "workIntakeProjectIds"]);
  const workers = record(owner.workers, ["hermes", "claude", "codex"]);
  // A socket directory, never a TCP host: the peer map is the login, and a host name
  // here would be a password-less connection attempt somewhere else.
  if (request.schema !== FIRST_OWNER_REQUEST_V1
    || typeof database.host !== "string" || !database.host.startsWith("/") || database.host.length > 512
    || database.host.includes("\0") || !Number.isSafeInteger(database.port)
    || (database.port as number) < 1 || (database.port as number) > 65535
    || !text(database.name, /^[a-z][a-z0-9_]{0,62}$/u) || database.user !== "postgres"
    || ![owner.tenantId, owner.workspaceId, owner.subject, owner.nodeBase, workers.hermes, workers.claude, workers.codex]
      .every(item => text(item, ID))
    || owner.provider !== "local-owner"
    || !Array.isArray(owner.workIntakeProjectIds)
    || !text(request.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    || new Date(request.createdAt as string).toISOString() !== request.createdAt
    || !text(request.reviewKey, /^[A-Za-z0-9_-]{43}$/u)
    || Buffer.from(request.reviewKey as string, "base64url").toString("base64url") !== request.reviewKey) {
    refuse("first_owner_request_refused");
  }
  return request as unknown as FirstOwnerRequestV1;
}

/** The release's own manifest, from the installer's explicit values. */
export function firstOwnerManifestFromRequestV1(request: FirstOwnerRequestV1) {
  const { owner } = request;
  const reviewKey = Uint8Array.from(Buffer.from(request.reviewKey, "base64url"));
  const genesis = CompletionGateStoreV1.genesisIntegrityForKeyV1(owner.tenantId, reviewKey);
  return createMacLocalFirstOwnerManifestV1({
    workspaceId: owner.workspaceId,
    localOwnerSession: { tenantId: owner.tenantId, provider: owner.provider, subject: owner.subject },
    enablement: { nodeId: owner.nodeBase, workers: [
      { kind: "hermes", workerId: owner.workers.hermes },
      { kind: "claude-code", workerId: owner.workers.claude },
      { kind: "codex", workerId: owner.workers.codex },
    ] },
    workIntakeProjectIds: [...owner.workIntakeProjectIds],
  }, request.createdAt, genesis);
}

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** The transaction plus the identity read back from its own rows. */
export async function runFirstOwnerRequestV1(client: Queryable, request: FirstOwnerRequestV1) {
  const peer = (await client.query("SELECT current_user, session_user, inet_client_addr() AS client_addr,"
    + " current_database() AS database")).rows[0];
  if (peer?.current_user !== "postgres" || peer?.session_user !== "postgres" || peer?.client_addr !== null
    || peer?.database !== request.database.name) refuse("first_owner_postgres_peer_required");
  const manifest = firstOwnerManifestFromRequestV1(request);
  const receipt = await applyMacLocalFirstOwnerV1(client, manifest);
  // The identity is READ BACK, so the provider and subject the installer composes
  // into protected configuration are proven to be the row the owner signs in as:
  // the row's digest must equal the release's digest of exactly these two values.
  const rows = (await client.query("SELECT i.auth_provider, i.auth_subject_digest, w.id AS workspace_id"
    + " FROM control_identities i JOIN workspaces w ON w.tenant_id = i.tenant_id"
    + " WHERE i.id=$1 AND i.tenant_id=$2 AND w.id=$3",
  [manifest.identity.id, manifest.tenant.id, manifest.workspace.id])).rows;
  const subjectDigest = sha256Digest({ provider: request.owner.provider, subject: request.owner.subject });
  if (rows.length !== 1 || rows[0]?.auth_provider !== request.owner.provider
    || rows[0]?.auth_subject_digest !== subjectDigest || subjectDigest !== manifest.identity.subjectDigest
    || rows[0]?.workspace_id !== request.owner.workspaceId) refuse("first_owner_identity_refused");
  return Object.freeze({ schema: FIRST_OWNER_RESULT_V1, receipt,
    identity: Object.freeze({ provider: request.owner.provider, subject: request.owner.subject,
      workspaceId: request.owner.workspaceId }) });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).byteLength;
    if (size > FIRST_OWNER_MAXIMUM_REQUEST_BYTES_V1) refuse("first_owner_request_refused");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const KNOWN_CODES = new Set(["first_owner_request_refused", "first_owner_postgres_peer_required",
  "first_owner_identity_refused", "first_owner_row_conflict", "first_owner_row_count_invalid",
  "first_owner_column_policy_drift", "first_owner_column_policy_invalid", "first_owner_key_immutability_missing",
  "completion_gate_state_advanced", "mac_local_first_owner_manifest_invalid"]);

/** The CLI boundary: one request in, one line out, a fixed code on failure. */
export async function mainFirstOwnerV1(args: readonly string[]): Promise<number> {
  if (args.length !== 0) { process.stderr.write("first-owner failed: first_owner_usage_refused\n"); return 64; }
  let client: Client | undefined;
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(await readStdin()); } catch { refuse("first_owner_request_refused"); }
    const request = parseFirstOwnerRequestV1(parsed);
    client = new Client({ host: request.database.host, port: request.database.port, database: request.database.name,
      user: request.database.user, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 30_000,
      application_name: "control-room-first-owner" });
    await client.connect();
    const result = await runFirstOwnerRequestV1(client as unknown as Queryable, request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof Error && KNOWN_CODES.has(error.message) ? error.message : "first_owner_failed";
    process.stderr.write(`first-owner failed: ${code}\n`);
    return 1;
  } finally { await client?.end().catch(() => undefined); }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void mainFirstOwnerV1(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write("first-owner failed: first_owner_failed\n");
    process.exitCode = 1;
  });
}

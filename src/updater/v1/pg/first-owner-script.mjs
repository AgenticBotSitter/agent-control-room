// N1: `firstOwnerViaScriptV1`, the PRODUCTION first-owner port.
//
// M4's `firstOwnerV1` is the check; it delegates the transaction and refused
// `first_owner_dependency_refused` on the install path because nothing built its
// dependencies. The transaction is RELEASE code over `pg`, which the fixed updater
// does not carry, so this port runs the release's own bundled entry
// (`<root>/current/dist-vps/server/firstOwner.js`) as a child of the release's
// pinned Node (`<root>/runtime/node-current/bin/node`), as the DATABASE ACCOUNT
// (the peer map's `cr _crdb postgres` line, `FIRST_OWNER_IDENTITY_V1`), and hands
// M4's check the child's answer. The trust rule holds at the process boundary.
//
// THE BOUNDARY, stated once:
//   - stdin: ONE JSON document — socket directory, port, database name and login,
//     the owner identity values the installer chose, `createdAt`, and the
//     completion-gate review key. The key is the only secret and it travels on
//     stdin alone: never argv, never the environment, never a log line.
//   - stdout: ONE JSON line, `{schema, receipt, identity}`, with exact keys.
//   - a non-zero exit, a timeout, extra output or a malformed line is a refusal,
//     and the installer rolls back.
//
// NOTHING IS READ FROM PROTECTED CONFIGURATION. That configuration is composed AFTER
// this step, from this step's result. The socket and port come from the install
// root's layout and the release's role manifest (the one file init and health also
// read the port from); the owner values come from the installer's input.
//
// IDEMPOTENT ON RETRY. `createdAt` and the review key are the only values the
// installer does not fix in advance, and both are written ONCE, before the first
// spawn, to `<root>/updater-state/first-owner.json` (0600, this process's account).
// A re-run reads them back, so a run killed before COMMIT creates the rows and a run
// killed after COMMIT finds every row identical and keeps it — the release's
// transaction compares every row and refuses `first_owner_row_conflict` otherwise.
// The same file is where the release's later task-runtime composition must take the
// review key from, or the genesis row it signs cannot be verified.
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { assertT1Path } from "../trusted-runtime.mjs";
import { databaseSessionContextV1 } from "./database-health-production.mjs";
import { firstOwnerV1 } from "./first-owner-ports.mjs";
import { ensureFirstOwnerStateV1 } from "./first-owner-state.mjs";
import { digestReleaseSchemaRowsV1, readReleaseSchemaDigestSqlV1 } from "./release-schema-digest.mjs";
import { runSessionStatementV1 } from "./sql-session.mjs";

export const FIRST_OWNER_REQUEST_V1 = "control-room.first-owner-request/v1";
export const FIRST_OWNER_RESULT_V1 = "control-room.first-owner-result/v1";
export { ensureFirstOwnerStateV1, FIRST_OWNER_STATE_V1 } from "./first-owner-state.mjs";
export const FIRST_OWNER_ENTRY_V1 = Object.freeze(["current", "dist-vps", "server", "firstOwner.js"]);
export const FIRST_OWNER_NODE_V1 = Object.freeze(["runtime", "node-current", "bin", "node"]);
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safeRoot = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && resolve(value) === value && value !== "/" && !value.includes("\0");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/u;

/** The owner values the installer passes, exactly. */
export function parseFirstOwnerOwnerV1(value) {
  if (!exactKeys(value, ["tenantId", "workspaceId", "provider", "subject", "nodeBase", "workers", "workIntakeProjectIds"])
    || !exactKeys(value.workers, ["hermes", "claude", "codex"])
    || ![value.tenantId, value.workspaceId, value.subject, value.nodeBase,
      value.workers.hermes, value.workers.claude, value.workers.codex].every(item => typeof item === "string" && ID.test(item))
    || value.provider !== "local-owner" || !Array.isArray(value.workIntakeProjectIds)
    || value.workIntakeProjectIds.length > 32
    || value.workIntakeProjectIds.some(item => typeof item !== "string" || !/^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,179})$/u.test(item))) {
    refuse("first_owner_input_refused");
  }
  return Object.freeze({ tenantId: value.tenantId, workspaceId: value.workspaceId, provider: value.provider,
    subject: value.subject, nodeBase: value.nodeBase,
    workers: Object.freeze({ hermes: value.workers.hermes, claude: value.workers.claude, codex: value.workers.codex }),
    workIntakeProjectIds: Object.freeze([...value.workIntakeProjectIds]) });
}

function firstOwnerChildIdentity(accounts) {
  if (!Number.isSafeInteger(accounts?.service?.gid) || accounts.service.gid < 1) {
    refuse("first_owner_input_refused");
  }
  // Peer auth uses D's uid; the service group can read the root:service release.
  return { uid: accounts.database.uid, gid: accounts.service.gid };
}

/** Spawn the release entry once: one request in, one bounded line out. */
export function runFirstOwnerEntryV1({ executable, entry, cwd, accounts, request, timeoutMs, onSpawn }, spawnEntry = spawn) {
  const identity = firstOwnerChildIdentity(accounts);
  return new Promise((resolvePromise, reject) => {
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > MAXIMUM_OUTPUT_BYTES) { reject(Object.assign(new Error("first_owner_request_refused"), { code: "first_owner_request_refused" })); return; }
    // The environment is FIXED, not inherited: no PG* variable, no NODE_OPTIONS and
    // no HOME can steer the child to another server, a `.pgpass` or a preload.
    const child = spawnEntry(executable, [entry], { cwd, uid: identity.uid, gid: identity.gid, shell: false,
      stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", HOME: "/var/empty", PGPASSFILE: "/dev/null" } });
    onSpawn?.(child);
    let stdout = Buffer.alloc(0), stderr = "", overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => {
      if (stdout.byteLength + chunk.byteLength > MAXIMUM_OUTPUT_BYTES) { overflow = true; child.kill("SIGKILL"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.once("error", error => { clearTimeout(timer); reject(Object.assign(new Error("first_owner_script_failed:spawn"),
      { code: "first_owner_script_failed", cause: error?.code })); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // Only the child's own fixed refusal code is repeated, never free text: the
      // installer journals this message, and a stack trace is not a reason.
      const reason = /first-owner failed: ([a-z_]{1,80})\s*$/u.exec(stderr)?.[1] ?? "unknown";
      if (timedOut) { reject(Object.assign(new Error("first_owner_script_timeout"), { code: "first_owner_script_timeout" })); return; }
      if (overflow) { reject(Object.assign(new Error("first_owner_result_refused:output"), { code: "first_owner_result_refused" })); return; }
      if (code !== 0) {
        reject(Object.assign(new Error(`first_owner_script_failed:${signal ?? code}:${reason}`), { code: "first_owner_script_failed" }));
        return;
      }
      resolvePromise(stdout.toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(line);
  });
}

/** Exactly one JSON line with exactly the result keys, naming exactly the owner sent. */
export function parseFirstOwnerResultV1(text, owner) {
  if (typeof text !== "string" || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    refuse("first_owner_result_refused");
  }
  let value;
  try { value = JSON.parse(text); } catch { refuse("first_owner_result_refused"); }
  if (!exactKeys(value, ["schema", "receipt", "identity"]) || value.schema !== FIRST_OWNER_RESULT_V1
    || !exactKeys(value.identity, ["provider", "subject", "workspaceId"])
    || value.identity.provider !== owner.provider || value.identity.subject !== owner.subject
    || value.identity.workspaceId !== owner.workspaceId
    || !exactKeys(value.receipt, ["schema", "manifestDigest", "tenantId", "created", "kept", "fingerprints"])) {
    refuse("first_owner_result_refused");
  }
  return value;
}

/**
 * `firstOwner` on the install path.
 *
 * Input, exactly: `{root, accounts, release: "current", schemaDigest, pgDataId, owner}`.
 * The schema digest is compared BEFORE the spawn (M4's rule: no owner is minted on a
 * schema that has drifted from step 22's), and M4's `firstOwnerV1` checks the
 * receipt, the tenant and the identity and returns its four keys.
 *
 * `runtime` overrides are for a lane that cannot be root: `assertPath` (T1 needs a
 * root-owned ancestry) and `readRoleManifest` (the lane cannot bind 5432). `onSpawn`
 * observes the child. None of them changes what the child is given.
 */
export async function firstOwnerViaScriptV1(input, runtime = {}) {
  if (!exactKeys(input, ["root", "accounts", "release", "schemaDigest", "pgDataId", "owner"]) || !safeRoot(input.root)
    || input.release !== "current" || typeof input.pgDataId !== "string" || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId)
    || !Number.isSafeInteger(input.accounts?.database?.uid) || !Number.isSafeInteger(input.accounts?.database?.gid)
    || input.accounts.database.uid < 1 || input.accounts.database.gid < 1) {
    refuse("first_owner_input_refused");
  }
  firstOwnerChildIdentity(input.accounts);
  const owner = parseFirstOwnerOwnerV1(input.owner);
  const { root } = input;
  let session;
  try { session = await databaseSessionContextV1(root, input.pgDataId, { readRoleManifest: runtime.readRoleManifest }); }
  catch (error) { refuse(`first_owner_database_refused:${String(error?.code ?? error?.message ?? "session").slice(0, 120)}`); }
  const { manifest, context } = session;
  // The child runs as the account that OWNS the data directory, and that must be the
  // database account the installer created: the peer map sends exactly that account
  // to `postgres`, and any other would be refused by the server — or worse, accepted
  // as somebody else.
  if (context.identity.uid !== input.accounts.database.uid) refuse("first_owner_database_account_refused");
  const assertPath = runtime.assertPath ?? assertT1Path;
  const executable = await assertPath(join(root, ...FIRST_OWNER_NODE_V1), { allowedRoots: [root], executable: true });
  const entry = await assertPath(join(root, ...FIRST_OWNER_ENTRY_V1), { allowedRoots: [root] });
  const digestSql = await readReleaseSchemaDigestSqlV1(root);
  const state = await ensureFirstOwnerStateV1(root, runtime);
  let answer = null;
  return firstOwnerV1({ root, accounts: input.accounts, release: input.release, schemaDigest: input.schemaDigest }, {
    tenantId: owner.tenantId,
    databaseName: manifest.database,
    digestRows: digestReleaseSchemaRowsV1,
    readDigest: () => runSessionStatementV1({ user: manifest.migratorLogin, database: manifest.database, sql: digestSql },
      context),
    applyMacLocalFirstOwnerV1: async () => {
      const request = { schema: FIRST_OWNER_REQUEST_V1,
        database: { host: context.layout.socketDirectory, port: manifest.port, name: manifest.database, user: "postgres" },
        owner: { ...owner, workers: { ...owner.workers }, workIntakeProjectIds: [...owner.workIntakeProjectIds] },
        createdAt: state.createdAt, reviewKey: state.reviewKey };
      answer = parseFirstOwnerResultV1(await runFirstOwnerEntryV1({ executable, entry, cwd: join(root, "current"), accounts: input.accounts, request,
        timeoutMs: runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS, onSpawn: runtime.onSpawn }), owner);
      return answer.receipt;
    },
    readIdentity: async tenantId => tenantId === owner.tenantId && answer ? answer.identity : null,
  });
}

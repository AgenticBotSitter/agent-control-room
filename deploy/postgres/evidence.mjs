// Shared evidence collector for the #63 backup/restore package. Reads schema,
// ledger rows, role attributes, role memberships, ownership/grants and
// required-row hashes from one database without modifying it. Restored clusters
// never carry roles (pg_restore --no-owner skips cluster globals), so the
// operator provisions the target logins first (db/roles/production_provision.sql),
// restore reconciles the recorded memberships, and rolesDigest/membershipsDigest
// are always computed from the TARGET's observed state — never copied from backup
// metadata. A restore with missing or unsafe role authority fails closed.
import { createHash } from "node:crypto";
import { Client } from "pg";

const sha256 = text => createHash("sha256").update(text).digest("hex");

export const digestOf = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

// Shared snapshot fragments: the backup snapshot collector (open-transaction)
// and the point-in-time collector below must select byte-identical role and
// membership shapes, or backup-vs-restore digests would differ spuriously.
export const ROLES_SNAPSHOT_SQL =
  `SELECT rolname, rolcanlogin, rolcreatedb, rolcreaterole, rolsuper, rolreplication, rolbypassrls FROM pg_roles
   WHERE rolname LIKE 'control\\_room\\_%' ORDER BY rolname`;
export const MEMBERSHIPS_SNAPSHOT_SQL =
  `SELECT member.rolname AS member, role.rolname AS role, am.admin_option FROM pg_auth_members am
   JOIN pg_roles member ON member.oid = am.member JOIN pg_roles role ON role.oid = am.roleid
   WHERE member.rolname LIKE 'control@_room@_%' ESCAPE '@' OR role.rolname LIKE 'control@_room@_%' ESCAPE '@'
   ORDER BY 1, 2`;

// R5B-10: the roles that own a DEFAULT ACL, which is what `pg_dump` replays as
// `ALTER DEFAULT PRIVILEGES FOR ROLE <name>`.
//
// WHY IT EXISTS. A default ACL is a per-ROLE setting (`pg_default_acl.defaclrole`),
// so the role that ISSUED the `ALTER DEFAULT PRIVILEGES` owns it — and that is
// whichever role the release's own role file happened to run as. The eight
// Mac-local privilege files run as the BOOTSTRAP SUPERUSER
// (`scripts/mac-local/narrow-role-provision.mjs` and `apply-release-schema.mjs`
// both apply them as `postgres`), and a bare `ALTER DEFAULT PRIVILEGES … FROM
// PUBLIC` therefore records the SUPERUSER as the owner. MEASURED on PostgreSQL
// 17: on a cluster whose superuser is `fixture_admin`, applying
// `db/roles/private_web_roles.sql` as that superuser left `fixture_admin` as the
// defacl owner, and the dump carried a `DEFAULT ACL` TOC entry for it.
//
// `pg_dump` then emits that entry as `ALTER DEFAULT PRIVILEGES FOR ROLE
// fixture_admin`, and `pg_restore` answers `role "fixture_admin" does not exist`
// on a target whose superuser is named `postgres`. Harmless on the Mac install,
// where both sides are `postgres`; it bites on the planned managed-VPS move,
// where the superuser has whatever name the provider chose.
//
// The dump is not optional — a restore must reproduce what was backed up — so
// the role is recorded here, from the SAME snapshot as every other piece of
// evidence, and the restore creates it before `pg_restore` replays the
// statement. Restoring the backup's own record is the same rule the restore
// already follows for the canonical owner and the recorded database owner.
//
// Cluster-global (`pg_default_acl` has no per-database namespace), so this is
// the whole cluster's default ACLs, exactly like `ROLES_SNAPSHOT_SQL`.
export const DEFAULT_ACL_ROLES_SNAPSHOT_SQL =
  `SELECT pg_get_userbyid(defaclrole) AS owner, defaclobjtype::text AS objectType
   FROM pg_default_acl ORDER BY 1, 2`;

/**
 * Accepts a postgres URL string (operator CLI) or a node-postgres config object
 * (tests and embedding tools). Keyword-style `host=… dbname=…` strings are NOT
 * valid connection strings — pass `{ host, port, database, user, password }`.
 * @param {string | Record<string, unknown>} target
 */
const SCHEMA_SNAPSHOT = `
  SELECT coalesce(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.kind, snapshot.name, snapshot.detail), '[]'::jsonb) AS snapshot
  FROM (
    SELECT 'table' AS kind, n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
           CASE WHEN con.contype = 'c' THEN 'check:' || con.contype::text || '|key:' || array_to_string(con.conkey, ',') || '|expr:' || regexp_replace(regexp_replace(regexp_replace(pg_get_expr(con.conbin, con.conrelid), '\s', '', 'g'), '[()]', '', 'g'), '::', '.', 'g')
                ELSE 'def:' || pg_get_constraintdef(con.oid) END
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    SELECT 'index', n.nspname || '.' || c.relname || '.' || i.relname, pg_get_indexdef(i.oid)
    FROM pg_index idx JOIN pg_class c ON c.oid = idx.indrelid JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> 'control_room_schema_migrations'
    UNION ALL
    -- Functions and triggers: these enforce the security-critical protections
    -- (e.g. INSERT/SELECT policies, integrity triggers, immutability). A schema
    -- digest that omits them cannot prove that the restored database actually
    -- enforces its claimed protections — a restore that drops a trigger would
    -- otherwise compare equal against a backup that included it.
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
    UNION ALL
    SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) snapshot`;

/**
 * @param {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<string>}
 */
export async function readSchemaDigest(client) {
  const { rows } = await client.query(SCHEMA_SNAPSHOT);
  return `sha256:${sha256(JSON.stringify(rows[0].snapshot))}`;
}

/**
 * Split a target into pg-tool CLI arguments plus a secrets env overlay.
 * @param {string | Record<string, any>} target
 */
export function targetCli(target) {
  if (typeof target === "string") {
    if (!/^\w+:\/\//u.test(target.trim())) {
      const config = parseKeywordValueTarget(target);
      const password = config.password;
      delete config.password;
      const text = Object.entries(config).map(([key, value]) =>
        `${key === "database" ? "dbname" : key}='${String(value).replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`).join(" ");
      return { args: ["--dbname", text], env: password === undefined ? {} : { PGPASSWORD: String(password) } };
    }
    // Preserve libpq's URI syntax, including multiple hosts and encoded socket
    // paths. A web URL parser rejects those; query '+' is literal in libpq.
    const match = /^(postgres(?:ql)?:\/\/)([^/?#]*)(.*)$/u.exec(target.trim());
    if (!match) throw new Error("target_connection_string_invalid");
    let [, prefix, authority, suffix] = match, password;
    const decode = value => {
      try { return decodeURIComponent(value); } catch { throw new Error("target_connection_string_invalid"); }
    };
    const at = authority.lastIndexOf("@"), colon = authority.slice(0, at).indexOf(":");
    if (at >= 0 && colon >= 0) {
      password = decode(authority.slice(colon + 1, at));
      authority = authority.slice(0, colon) + authority.slice(at);
    }
    const query = suffix.indexOf("?");
    if (query >= 0) {
      const kept = suffix.slice(query + 1).split("&").filter(part => {
        const equals = part.indexOf("=");
        if (equals < 0 || decode(part.slice(0, equals)) !== "password") return true;
        password = decode(part.slice(equals + 1));
        return false;
      });
      suffix = suffix.slice(0, query) + (kept.length ? "?" + kept.join("&") : "");
    }
    return { args: ["--dbname", prefix + authority + suffix], env: password === undefined ? {} : { PGPASSWORD: password } };
  }
  const { host, port, database, user, password } = target;
  return { args: ["-h", String(host), "-p", String(port), "-U", String(user), "-d", String(database)],
    env: password === undefined ? {} : { PGPASSWORD: String(password) } };
}

/**
 * Parse a libpq keyword/value connection string ("host=... port=... dbname=...
 * user=... password=...") into a pg config object. Single quotes group values
 * with spaces; a backslash escapes the next character. URIs are not handled
 * here (pass those through as connectionString).
 */
export function parseKeywordValueTarget(text) {
  const config = {};
  const tokenPattern = /([A-Za-z_][A-Za-z0-9_]*)=('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\s]*)/g;
  let match, consumed = 0;
  const unquote = (value) => {
    if (value.length >= 2 && (value.startsWith("'") || value.startsWith('"'))) {
      const quote = value[0];
      if (!value.endsWith(quote)) throw new Error("target_connection_string_invalid");
      return value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return value;
  };
  while ((match = tokenPattern.exec(text)) !== null) {
    if (text.slice(consumed, match.index).trim() !== "") throw new Error("target_connection_string_invalid");
    consumed = tokenPattern.lastIndex;
    const [, key, raw] = match;
    const value = unquote(raw);
    if (key === "dbname") config.database = value;
    else if (key === "port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("target_connection_string_invalid");
      config.port = port;
    } else config[key] = value;
  }
  if (Object.keys(config).length === 0 || text.slice(consumed).trim() !== "") {
    throw new Error("target_connection_string_invalid");
  }
  return config;
}

export function connectTarget(target) {
  // eslint-disable-next-line import/no-extraneous-dependencies
  if (typeof target === "string" && !/^\w+:\/\//.test(target.trim())) {
    return new Client(parseKeywordValueTarget(target));
  }
  return new Client(typeof target === "string" ? { connectionString: target } : { ...target });
}

/**
 * @param {string} connectionString
 * @param {{ requiredTables?: string[] }} [options]
 * @returns {Promise<{ ledger: any[], roles: any[], memberships: any[], grants: any[], rows: { table: string, count: number, hash: string }[], schemaDigest: string, databaseOwner: string }>}
 */
export async function collectDatabaseEvidence(target, { requiredTables = [] } = {}) {
  const client = connectTarget(target);
  await client.connect();
  try {
    const ledger = (await client.query(
      "SELECT filename, digest, ledger_order, pre_schema_digest, post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    // Least-privilege identity: every sensitive attribute, so a restored role
    // with flipped SUPERUSER/REPLICATION/BYPASSRLS (or lost LOGIN) cannot
    // compare equal to the backup.
    const roles = (await client.query(ROLES_SNAPSHOT_SQL)).rows;
    // Memberships in either direction: grants TO our logins/groups (unexpected
    // authority flowing in) and grants OF our groups to anyone (authority
    // leaking out). admin_option is the administration right — recorded so a
    // restored WITH ADMIN OPTION mismatch fails closed.
    const memberships = (await client.query(MEMBERSHIPS_SNAPSHOT_SQL)).rows;
    const grants = (await client.query(
      `SELECT n.nspname || '.' || c.relname AS object, pg_get_userbyid(c.relowner) AS owner,
              coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))::text AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v') ORDER BY 1`)).rows;
    const rows = [];
    for (const table of requiredTables) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`evidence_refused_table:${table}`);
      const values = (await client.query(`SELECT to_jsonb(t) AS v FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
      rows.push({ table, count: values.length, hash: digestOf(values) });
    }
    // Database owner: a restored database must carry the source's pg_database
    // owner, not the invoking administrator. Bound into the restore identity
    // (databaseOwnerDigest) and re-applied by restore from the recorded name.
    const databaseOwner = (await client.query(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()")).rows[0]?.owner;
    if (typeof databaseOwner !== "string" || !/^[a-z0-9_]+$/.test(databaseOwner)) {
      throw new Error("evidence_refused_database_owner");
    }
    return { ledger, roles, memberships, grants, rows, schemaDigest: await readSchemaDigest(client), databaseOwner };
  } finally {
    await client.end();
  }
}

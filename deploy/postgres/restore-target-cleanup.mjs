// Planning and applying the cleanup that makes a RETRY of an interrupted
// restore possible (R5B-04).
//
// WHY THIS EXISTS. `pg_restore` is not transactional. An interrupted restore —
// a killed process, a full disk, a dropped connection — leaves the target
// holding the objects the dump had got as far as creating, and the SAME command
// then refuses that target as non-empty with no way forward. The instruction
// the tool used to print for the reset, "a second restore into the same
// database starts from DROP SCHEMA public", does not work either, and the
// reason is exactly the finding: the queue schema is not `public`. MEASURED on
// PostgreSQL 17 (round 5, R5B-04): after a good restore, `DROP SCHEMA public
// CASCADE; CREATE SCHEMA public` leaves `control_room_queue` standing, and the
// retry then fails inside `pg_restore` with `schema "control_room_queue"
// already exists` and `type "job_state" already exists`, having already left 243
// tables behind — so the THIRD attempt is the nonempty refusal. The documented
// retry could never succeed.
//
// Two things had to be true at once: the emptiness check has to see every
// non-system schema rather than only `public` tables, and the cleanup has to be
// driven by the DUMP's own table of contents so that it removes exactly what a
// retry would collide with. `--clean --if-exists` is not that: MEASURED, it
// fails on this schema with `cannot drop inherited constraint
// "queue_stats_20261003_pkey"`, because pg_restore emits an explicit
// `ALTER TABLE ... DROP CONSTRAINT` for a partition's primary key and
// PostgreSQL refuses to drop an inherited constraint that way. Dropping the
// objects themselves has no such problem.
//
// THE SAFETY RULE, and it is the whole point of doing this with a plan:
//   1. Everything here is decided by PURE functions over the dump's TOC and the
//      target's observed catalogue, and refused with a named code before
//      anything is dropped.
//   2. A target holding any relation the dump does NOT name is REFUSED, never
//      cleaned. That is what keeps an unrelated database from being emptied —
//      the refusal this cleanup sits behind is unchanged for anyone who does not
//      ask for it by name.
//   3. Every object to be dropped is one the dump will create, so a successful
//      cleanup leaves the target in the state `pg_restore` expects.
//   4. Ownership is checked BEFORE the first drop, so a refused cleanup has not
//      destroyed anything on its way to being refused. The queue schema is
//      deliberately owned by `postgres` (R5B-01), which is the case that
//      actually needs this check.
//
// Nothing here decides whether to retry. The operator asks for that with
// `--retry-into-half-restored`, because it destroys objects and must never be
// something a retry does by surprise.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Relation kinds the dump can create and a cleanup must therefore drop.
const DROPPABLE_RELATIONS = new Set(["TABLE", "SEQUENCE", "VIEW", "MATERIALIZED VIEW"]);
// A composite type belongs to its table and is dropped with it; a standalone
// one (enum, domain, a plain CREATE TYPE) has to be named.
const DROPPABLE_TYPES = new Set(["TYPE", "DOMAIN"]);
const DROPPABLE_ROUTINES = new Set(["FUNCTION", "PROCEDURE", "AGGREGATE"]);

/** PostgreSQL's own system schemas, which a restore never creates. */
export const SYSTEM_SCHEMAS_V1 = Object.freeze(["pg_catalog", "information_schema", "pg_toast"]);

/**
 * Is this schema name one a restore would have created?
 *
 * `pg_temp_*` is PostgreSQL's own per-session temporary schemas. It is not in
 * `SYSTEM_SCHEMAS_V1` because its suffix is a pid, and it must never be dropped:
 * it can belong to another session.
 *
 * @param {unknown} name
 */
export function isRestorableSchemaNameV1(name) {
  return typeof name === "string" && /^[a-z0-9_]+$/u.test(name)
    && !SYSTEM_SCHEMAS_V1.includes(name) && !name.startsWith("pg_");
}

/**
 * Parse `pg_restore --list` output into the objects a restore would create.
 *
 * A TOC line is `<dumpId>; <tableoid> <oid> <DESC> <schema> <name> <owner>`,
 * and the trailing fields vary by entry kind — an `ACL` or `COMMENT` line has no
 * reliable schema/name pair. Only the entry kinds that create a droppable
 * object are read, and only their first five fields are trusted; anything
 * shorter is skipped rather than guessed at.
 *
 * @param {string} text raw `pg_restore --list` output
 * @returns {{ schemas: string[], relations: { schema: string, name: string }[],
 *   types: { schema: string, name: string }[], routines: { schema: string, name: string }[] }}
 */
export function parseRestoreTocV1(text) {
  if (typeof text !== "string") throw new Error("restore_toc_shape");
  const schemas = new Set();
  const relations = [];
  const types = [];
  const routines = [];
  const seen = new Set();
  const add = (bucket, kind, schema, name) => {
    if (!isRestorableSchemaNameV1(schema) || !/^[a-z0-9_$]+$/u.test(name)) return;
    schemas.add(schema);
    const key = `${kind}:${schema}.${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push({ schema, name });
  };
  for (const line of text.split("\n")) {
      const fields = line.split(";");
      if (fields.length < 2) continue;
      const rest = fields.slice(1).join(";").trim().split(/\s+/u);
      if (rest.length < 5) continue;
      const kind = rest[2];
      const schema = rest[3];
      const name = rest[4];
      // A FUNCTION or AGGREGATE entry carries its ARGUMENT LIST in the name
      // field: MEASURED on this schema's own dump, `control_room_queue
      // create_queue(text, jsonb)`. Matching that whole field against the
      // identifier pattern — or against `pg_proc.proname` — silently drops every
      // function that takes an argument, which is most of them, and the retry then
      // dies on `function ... already exists`. So the argument list is cut here,
      // once, at the parse boundary.
      const bare = DROPPABLE_ROUTINES.has(kind) ? name.split("(")[0] : name;
      if (!isRestorableSchemaNameV1(schema) || !/^[a-z0-9_$]+$/u.test(bare)) continue;
      if (DROPPABLE_RELATIONS.has(kind)) add(relations, kind, schema, bare);
      else if (DROPPABLE_TYPES.has(kind)) add(types, kind, schema, bare);
      else if (DROPPABLE_ROUTINES.has(kind)) add(routines, kind, schema, bare);
    }
  return { schemas: [...schemas].sort(), relations, types, routines };
}

/**
 * Read the dump's table of contents with the SAME `pg_restore` binary that will
 * perform the restore. It reads the archive file only, and opens no connection.
 *
 * @param {string} pgBin
 * @param {string} dumpPath
 */
export async function readRestoreTocV1(pgBin, dumpPath) {
  const { stdout } = await exec(joinPath(pgBin, "pg_restore"), ["--list", dumpPath],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 120_000, maxBuffer: 1 << 28 });
  return parseRestoreTocV1(stdout);
}

const joinPath = (pgBin, tool) => `${pgBin.replace(/\/+$/u, "")}/${tool}`;

/**
 * Decide what a half-restored target needs, and refuse everything that cannot
 * be decided safely. Pure: it reads two catalogues and returns a plan.
 *
 * @param {ReturnType<typeof parseRestoreTocV1>} toc
 * @param {{ schemas: { name: string, owner: string, droppable: boolean }[],
 *   relations: { schema: string, name: string, droppable: boolean }[],
 *   routines?: { schema: string, name: string, droppable: boolean }[],
 *   types?: { schema: string, name: string, droppable: boolean }[],
 *   ownedRelations?: { schema: string, name: string, owner: string }[] }} target
 * @returns {{ refusal?: string, dropSchemas: string[], relations: { schema: string, name: string }[],
 *   routines: { schema: string, name: string }[], types: { schema: string, name: string }[],
 *   unknownRelations: string[] }}
 */
export function planHalfRestoredCleanupV1(toc, target) {
  if (!toc || !Array.isArray(toc.schemas) || !target || !Array.isArray(target.schemas)
    || !Array.isArray(target.relations)) throw new Error("restore_cleanup_shape");
  const plan = { dropSchemas: [], relations: [], routines: [], types: [], unknownRelations: [] };
  const namedRelations = new Set(toc.relations.map(relation => `${relation.schema}.${relation.name}`));
  // A sequence the dump does not name is still part of this restore when it
  // belongs to a table the dump DOES name - SERIAL and IDENTITY columns create
  // exactly that, and PostgreSQL will not let the sequence be dropped on its own
  // ("cannot drop sequence ... because column sequence of table ... requires
  // it"), so it has to go with its table. MEASURED on PostgreSQL 17.
  //
  // Without this, adding a column to a half-restored table made the retry refuse
  // as an unrelated target, which is the refusal firing at the wrong object: the
  // sequence is not somebody's data, it is an attribute of a table this backup
  // restores.
  // `owner` is already `schema.table`, so the key it maps to is itself.
  const ownedByDumpedTable = new Set((Array.isArray(target.ownedRelations) ? target.ownedRelations : [])
    .filter(row => typeof row?.schema === "string" && typeof row?.name === "string"
      && typeof row?.owner === "string" && namedRelations.has(row.owner))
    .map(row => `${row.schema}.${row.name}`));
  for (const relation of target.relations) {
    if (!isRestorableSchemaNameV1(relation.schema)) continue;
    const key = `${relation.schema}.${relation.name}`;
    if (!namedRelations.has(key) && !ownedByDumpedTable.has(key)) plan.unknownRelations.push(key);
    else plan.relations.push({ schema: relation.schema, name: relation.name });
  }
  // A target holding anything the dump does not name is not this backup's
  // half-restore. Refused, and named, rather than cleaned.
  if (plan.unknownRelations.length > 0)
    return { ...plan, refusal: `restore_refused_unrelated_target_object:${plan.unknownRelations[0]}` };
  // Every recorded relation the target holds must be droppable by THIS login, or
  // the cleanup cannot complete and must say so rather than drop a prefix and
  // leave the rest. A relation the dump names but the target lacks is not here
  // at all — there is nothing to drop.
  for (const relation of plan.relations) {
    const row = target.relations.find(candidate => candidate.schema === relation.schema
      && candidate.name === relation.name);
    if (row && !row.droppable)
      return { ...plan, refusal: `restore_refused_target_object_not_owned:${relation.schema}.${relation.name}` };
  }
  // `public` itself is never dropped: its owner and its ACL are not part of any
  // dump, and recreating it would silently change who owns the schema. Its
  // CONTENTS are dropped instead, which is all a restore collides with.
  for (const schema of target.schemas) {
    if (!isRestorableSchemaNameV1(schema.name) || schema.name === "public") continue;
    if (!toc.schemas.includes(schema.name)) continue;
    if (!schema.droppable)
      return { ...plan, refusal: `restore_refused_target_object_not_owned:${schema.name}` };
    plan.dropSchemas.push(schema.name);
  }
  // Routines and standalone types, by the same rule. Their relations are NOT
  // pushed here again: they were checked and recorded above, and a relation
  // appears once or not at all.
  for (const bucket of ["routines", "types"]) {
    const targetRows = bucket === "routines" ? target.routines : target.types;
    if (!Array.isArray(targetRows)) continue;
    for (const row of targetRows) {
      if (!isRestorableSchemaNameV1(row.schema)) continue;
      if (!toc[bucket].some(entry => entry.schema === row.schema && entry.name === row.name)) continue;
      if (!row.droppable) return { ...plan, refusal: `restore_refused_target_object_not_owned:${row.schema}.${row.name}` };
      plan[bucket].push({ schema: row.schema, name: row.name });
    }
  }
  plan.dropSchemas.sort();
  return plan;
}

/**
 * The catalogue facts `planHalfRestoredCleanupV1` reads, taken from the target
 * itself.
 *
 * `droppable` is the ownership question PostgreSQL answers with
 * `has_schema_privilege`/`pg_has_role`: a role may drop a schema or a relation
 * it owns, or one whose owning role it is a member of, and a superuser may drop
 * anything. Asking the server keeps this rule out of this file's hands.
 *
 * @param {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<{ schemas: any[], relations: any[], routines: any[], types: any[],
 *   ownedRelations: { schema: string, name: string, owner: string }[] }>}
 */
export async function readCleanupTargetStateV1(client) {
  const schemas = (await client.query(`SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
      (pg_has_role(current_user, n.nspowner, 'MEMBER') OR n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS droppable
    FROM pg_namespace n ORDER BY n.nspname`)).rows;
  const relations = (await client.query(`SELECT n.nspname AS schema, c.relname AS name,
      (pg_has_role(current_user, c.relowner, 'MEMBER') OR c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS droppable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f') ORDER BY n.nspname, c.relname`)).rows;
  const routines = (await client.query(`SELECT n.nspname AS schema, p.proname AS name,
      (pg_has_role(current_user, p.proowner, 'MEMBER') OR p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS droppable
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ORDER BY n.nspname, p.proname`)).rows;
  // Which sequence belongs to which table, as PostgreSQL itself records it.
  // `pg_depend` with an INTERNAL dependency from a class to a class is exactly a
  // SERIAL/IDENTITY column's sequence, and the tool must not refuse those as
  // objects the dump never named.
  // A SERIAL/IDENTITY sequence is linked to its table COLUMN: `pg_depend` carries
  // `deptype = 'a'` (AUTO) against `pg_class`, with `refobjsubid` holding the
  // column number. MEASURED on PostgreSQL 17 by reading the row: two plausible
  // wrong forms (`deptype = 'i'`, and `refclassid = pg_attribute`) each return
  // zero rows for a table with a SERIAL column, and both read correctly enough to
  // ship. This one is the shape the server actually reports.
  const ownedRelations = (await client.query(`SELECT n.nspname AS schema, c.relname AS name,
      table_ns.nspname || '.' || table_c.relname AS owner
    FROM pg_depend d JOIN pg_class c ON c.oid = d.objid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      JOIN pg_class table_c ON table_c.oid = a.attrelid
      JOIN pg_namespace table_ns ON table_ns.oid = table_c.relnamespace
    WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      AND d.deptype = 'a' AND c.relkind = 'S' ORDER BY n.nspname, c.relname`)).rows;
  const types = (await client.query(`SELECT n.nspname AS schema, t.typname AS name,
      (t.typrelid = 0 AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS droppable
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd') ORDER BY n.nspname, t.typname`)).rows;
  return { schemas, relations, routines, types, ownedRelations };
}

/**
 * Apply an accepted plan. One statement per object kind, each inside a DO block
 * so an object whose name PostgreSQL will not accept as an identifier fails the
 * whole cleanup rather than being skipped.
 *
 * @param {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @param {ReturnType<typeof planHalfRestoredCleanupV1>} plan
 */
export async function applyHalfRestoredCleanupV1(client, plan) {
  const quoted = value => `'${String(value).replaceAll("'", "''")}'`;
  const kindByRelkind = new Map([["r", "TABLE"], ["p", "TABLE"], ["S", "SEQUENCE"],
    ["v", "VIEW"], ["m", "MATERIALIZED VIEW"], ["f", "FOREIGN TABLE"]]);
  // A schema's objects go with `DROP SCHEMA ... CASCADE`, so only the schemas
  // themselves and the `public` contents are dropped object by object.
  const dropSchemas = plan.dropSchemas.filter(schema => isRestorableSchemaNameV1(schema));
  const publicRows = (await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid) AS is_child
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       AND c.relname = ANY($1::text[])`, [plan.relations.filter(relation => relation.schema === "public")
        .map(relation => relation.name)])).rows;
  const inPublic = new Set(plan.relations.filter(relation => relation.schema === "public")
    .map(relation => relation.name));
  for (const schema of dropSchemas) {
    await client.query(`DO $do$ BEGIN EXECUTE format('DROP SCHEMA %I CASCADE', ${quoted(schema)}); END $do$;`);
  }
  // Views and materialized views first, then children before parents, and
  // SEQUENCES LAST.
  //
  // That ordering IS the guard for SERIAL and IDENTITY columns. PostgreSQL refuses
  // to drop such a sequence on its own - "cannot drop sequence ... because column
  // sequence of table ... requires it" (MEASURED on PostgreSQL 17) - and dropping
  // its table first takes it. So rank, rather than a second lookup of the same
  // dependency: an earlier version read `pg_depend` to skip these sequences AND
  // ranked them last, and the mutation run showed the lookup redundant, because
  // the ordering alone already makes the sequence unreachable before its table.
  // Two mechanisms for one rule is one too many, so the ordering stays and the
  // lookup is gone.
  const ordered = publicRows.filter(row => inPublic.has(row.name)).sort((left, right) => {
    const rank = row => (row.relkind === "v" || row.relkind === "m" ? 0 : row.relkind === "S" ? 2 : 1);
    return rank(left) - rank(right)
      || (left.is_child === right.is_child ? 0 : left.is_child ? -1 : 1)
      || right.name.length - left.name.length;
  });
  for (const row of ordered) {
    const kind = kindByRelkind.get(row.relkind) ?? "TABLE";
    await client.query(`DO $do$ BEGIN EXECUTE format('DROP ${kind} IF EXISTS public.%I CASCADE', ${quoted(row.name)}); END $do$;`);
  }
  for (const routine of plan.routines) {
    if (routine.schema !== "public" || !isRestorableSchemaNameV1(routine.schema)) continue;
    await client.query(`DO $do$ DECLARE sig regprocedure; BEGIN
      FOR sig IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${quoted(routine.schema)} AND p.proname = ${quoted(routine.name)} LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', sig);
      END LOOP; END $do$;`);
  }
  for (const type of plan.types) {
    if (type.schema !== "public" || !isRestorableSchemaNameV1(type.schema)) continue;
    await client.query(`DO $do$ BEGIN EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', ${quoted(type.name)}); END $do$;`);
  }
}
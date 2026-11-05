import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import type { LoopRosterToolsV1 } from "./loop-roster-check";
import { loopRosterColumnsV1, LoopRosterFormatError, loopRosterSha256V1, parseLoopRosterV1, renderLoopRosterV1,
  type LoopRosterRowV1 } from "./loop-roster-render";
import type { LoopSelectionSourceParticipantV1, LoopRosterSnapshotSourceV1 } from "./loop-selection-snapshot";
import { WebSessionAuthority } from "./session-authority";

export const loopRosterExportNameV1 = "roster-export.tsv";
export const loopRosterCustodyMessageV1 =
  "roster edits unavailable: the service user does not own the tools route file (deployment setting, not a roster error)";
export const loopRosterMissingDirectoryMessageV1 = "roster directory missing: stage a fresh install with the B6 tools";

/** A roster edit or seed that cr (or the shape of the roster) refused. Nothing was committed. */
export class LoopRosterRefusedV1 extends Error {
  constructor(readonly reason: "rules" | "custody" | "empty" | "unavailable" | "format", readonly problems: readonly string[], message: string) {
    super(message);
  }
}

const field = z.string().max(1000);
const rowFields = Object.fromEntries(loopRosterColumnsV1.filter(column => column !== "name").map(column => [column, field])) as
  Record<Exclude<typeof loopRosterColumnsV1[number], "name">, typeof field>;
export const loopRosterUpsertBodySchemaV1 = z.object({ expectedVersion: z.number().int().min(1).max(9007199254740991),
  row: z.object(rowFields).strict() }).strict();
export const loopRosterOnBodySchemaV1 = z.object({ expectedVersion: z.number().int().min(1).max(9007199254740991),
  on: z.boolean() }).strict();
const nameSchema = z.string().min(1).max(200);
const idempotencyKey = /^[A-Za-z0-9:_-]{16,100}$/;

type StateRow = { version: string | number; exported_version: string | number | null; exported_sha256: string | null;
  seeded_from: string; last_idempotency_key: string | null; last_request_digest: string | null };
type ModelRow = { name: string; position: number; launcher: string; provider: string; family: string; model_class: string;
  roles: string; efforts: string; default_effort: string; cost: string; on_off: string; note: string; nick: string;
  max_build_grade: string; updated_by: string; updated_at: string | Date };

const toRow = (r: ModelRow): LoopRosterRowV1 => ({ name: r.name, launcher: r.launcher, provider: r.provider, family: r.family,
  class: r.model_class, roles: r.roles, efforts: r.efforts, default_effort: r.default_effort, cost: r.cost, on: r.on_off,
  note: r.note, nick: r.nick, max_build_grade: r.max_build_grade });
const columnValues = (row: LoopRosterRowV1) => [row.launcher, row.provider, row.family, row.class, row.roles, row.efforts,
  row.default_effort, row.cost, row.on, row.note, row.nick, row.max_build_grade];

async function readRoster(q: DatabaseSession, tenantId: string, lock = false) {
  const state = (await q.query<StateRow>(`SELECT version, exported_version, exported_sha256, seeded_from, last_idempotency_key,
    last_request_digest FROM control_loop_roster_state WHERE tenant_id=$1${lock ? " FOR UPDATE" : ""}`, [tenantId])).rows[0];
  const models = (await q.query<ModelRow>(`SELECT * FROM control_loop_roster_models WHERE tenant_id=$1 ORDER BY position`, [tenantId])).rows;
  return { state, models };
}
/** The coordinator uses exactly the roster master's reader and renderer. */
export async function readLoopRosterSnapshotSourceV1(tx: DatabaseSession, tenantId: string): Promise<LoopRosterSnapshotSourceV1> {
  const { state, models } = await readRoster(tx, tenantId);
  if (!state || !models.length || state.exported_version == null || !state.exported_sha256) throw new Error("selection_source_unavailable");
  return { version: String(state.version), exportedVersion: String(state.exported_version),
    exportedSha256: state.exported_sha256, text: renderLoopRosterV1(models.map(toRow)) };
}

export type LoopRosterExportResultV1 = { exported: boolean; version: number | null; message?: string };
export type LoopRosterEditResultV1 = { replayed: boolean; version: number; exported: boolean; message?: string };
/** Test seam only: called at the two crash points of an export. Production passes nothing. */
export type LoopRosterFaultsV1 = { afterTemporaryWrite?(): void | Promise<void>; afterRename?(): void | Promise<void> };

/** B6: the model roster master in the database and its one read-only export, `<install>/roster/roster-export.tsv`.
 * The rules stay in the tools: every candidate is run through `cr models check` before it is committed or exported.
 * The service never writes the tooling manifest, `config/` or `tools/`; only files under the roster directory. */
export class LoopRosterServiceV1 {
  readonly #authority: WebSessionAuthority;
  #exportChain: Promise<unknown> = Promise.resolve();
  #startMessage: string | undefined;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly tools: LoopRosterToolsV1, private readonly clock: () => number = Date.now,
    private readonly faults: LoopRosterFaultsV1 = {}, private readonly sources?: LoopSelectionSourceParticipantV1) {
    this.#authority = new WebSessionAuthority(db, scope, clock, "loop_roster");
  }

  get exportPath() { return join(this.tools.rosterRoot, loopRosterExportNameV1); }

  async #rosterDirectory() {
    try {
      const stat = await lstat(this.tools.rosterRoot);
      return stat.isDirectory() && !stat.isSymbolicLink() && await realpath(this.tools.rosterRoot) === this.tools.rosterRoot
        && (!this.sources || stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
    } catch { return false; }
  }

  /** Runs the real `cr models check` on a private per-call copy of the candidate. */
  async checkWithCr(text: string, rowCount: number): Promise<void> {
    if (rowCount < 1) throw new LoopRosterRefusedV1("empty", [], "roster empty: at least one model is required");
    if (!await this.#rosterDirectory()) throw new LoopRosterRefusedV1("unavailable", [], loopRosterMissingDirectoryMessageV1);
    const unavailable = () => new LoopRosterRefusedV1("unavailable", [], "roster check unavailable: the tools could not be run");
    let directory: string;
    try { directory = await mkdtemp(join(this.tools.rosterRoot, "check-")); }
    catch { throw new LoopRosterRefusedV1("unavailable", [], "roster check unavailable: the roster directory is not writable"); }
    try {
      const file = join(directory, "models.tsv");
      try {
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
      } catch { throw unavailable(); }
      let result: Awaited<ReturnType<LoopRosterToolsV1["check"]>>;
      try { result = await this.tools.check(file); }
      catch { throw unavailable(); }
      if (result.exitCode === 0) return;
      const lines = result.lines.map(line => line.split(file).join("roster"));
      if (result.exitCode === 8 && lines.some(line => line.includes("route file custody refused")))
        throw new LoopRosterRefusedV1("custody", [], loopRosterCustodyMessageV1);
      if (result.exitCode === 8) throw new LoopRosterRefusedV1("rules", lines, "the roster check refused this roster");
      throw unavailable();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async #read(q: Pick<DatabaseSession, "query">, lock = false) {
    return readRoster(q, this.scope.tenantId, lock);
  }

  /** The only way a state row is created. A second call when a state row exists is refused. */
  async seedFromTsv(text: string, label: "export-file" | "tools-seed"): Promise<{ version: number }> {
    let rows: LoopRosterRowV1[], canonical: string;
    try { rows = parseLoopRosterV1(text); canonical = renderLoopRosterV1(rows); }
    catch (error) {
      if (error instanceof LoopRosterFormatError) throw new LoopRosterRefusedV1("format", [],
        `roster file unreadable (${error.reason}); the header must be exactly: ${loopRosterColumnsV1.join(" ")}`);
      throw error;
    }
    await this.checkWithCr(text, rows.length);
    const seedSha = loopRosterSha256V1(text);
    // An export-file seed is already the export; record it only when its bytes are canonical so reconcile rewrites
    // a valid but non-canonical file (comments, blank lines) exactly once.
    const exported = label === "export-file" && canonical === text;
    const at = new Date(this.clock()).toISOString();
    await this.db.transaction(async tx => {
      await this.sources?.lockSources(tx);
      await this.sources?.invalidate(tx);
      const inserted = await tx.query(`INSERT INTO control_loop_roster_state(tenant_id,version,exported_version,exported_sha256,seeded_from,updated_at)
        VALUES($1,1,$2,$3,$4,$5) ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
      [this.scope.tenantId, label === "export-file" ? 1 : null, exported ? seedSha : null, `${label}:${seedSha}`, at]);
      if (inserted.rows.length !== 1) throw new WebAccessError("conflict");
      for (const [index, row] of rows.entries()) await tx.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,
        launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'system:roster-seed',$16)`,
      [this.scope.tenantId, row.name, index + 1, ...columnValues(row), at]);
    });
    return { version: 1 };
  }

  /** Service start (spec 3.3): reconcile when seeded, else seed from the export file, else from the tools seed. */
  async start(): Promise<LoopRosterExportResultV1 & { seeded: boolean }> {
    const result = await this.#start();
    this.#startMessage = result.message;
    return result;
  }

  async #start(): Promise<LoopRosterExportResultV1 & { seeded: boolean }> {
    if (!await this.#rosterDirectory()) return { seeded: false, exported: false, version: null, message: loopRosterMissingDirectoryMessageV1 };
    await this.#removeStale();
    const { state } = await this.#read(this.db);
    if (!state) {
      // Something at the export path that is not a regular file (a symlink, a directory) is never replaced by a seed.
      if (await lstat(this.exportPath).then(() => true, () => false) && await this.#regularText(this.exportPath) === undefined)
        return { seeded: false, exported: false, version: null, message: "roster not seeded: the export path is not a regular file" };
      const file = await this.#regularText(this.exportPath);
      const seed = file === undefined ? await this.#regularText(this.tools.toolsSeed) : undefined;
      if (file === undefined && seed === undefined) return { seeded: false, exported: false, version: null, message: "roster not seeded" };
      try { await this.seedFromTsv((file ?? seed)!, file !== undefined ? "export-file" : "tools-seed"); }
      catch (error) {
        if (error instanceof LoopRosterRefusedV1)
          return { seeded: false, exported: false, version: null, message: `roster not seeded: ${[error.message, ...error.problems].join("; ")}` };
        // A concurrent starter seeded first: reconcile below works from its state row.
        if (!(error instanceof WebAccessError && error.code === "conflict")) throw error;
      }
    }
    return { seeded: true, ...await this.reconcile() };
  }

  /** Re-export when the file or the recorded export differs from render(master). */
  async reconcile(): Promise<LoopRosterExportResultV1> {
    const { state, models } = await this.#read(this.db);
    if (!state) return { exported: false, version: null, message: "roster not seeded" };
    const version = Number(state.version);
    if (models.length === 0) return { exported: false, version, message: "roster empty, export refused" };
    const h = loopRosterSha256V1(renderLoopRosterV1(models.map(toRow)));
    const file = await this.#regularText(this.exportPath);
    if (file !== undefined && loopRosterSha256V1(file) === h && state.exported_sha256 === h
      && Number(state.exported_version) === version) return { exported: true, version };
    return this.exportRoster();
  }

  async #regularText(path: string) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      return await readFile(path, "utf8");
    } catch { return undefined; }
  }

  async #removeStale() {
    if (this.sources) {
      await this.db.transaction(async tx => {
        await this.sources!.lockSources(tx);
        // Check folders belong to their own calls; a source lease does not own them.
        for (const entry of await readdir(this.tools.rosterRoot, { withFileTypes: true }))
          if (entry.isFile() && /^roster-export\.tsv\.[a-f0-9]{32}\.tmp$/.test(entry.name))
            await rm(join(this.tools.rosterRoot, entry.name), { force: true });
      });
      return;
    }
    for (const entry of await readdir(this.tools.rosterRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^check-[A-Za-z0-9]{6}$/.test(entry.name)
        || entry.isFile() && /^roster-export\.tsv\.[a-f0-9]{32}\.tmp$/.test(entry.name))
        await rm(join(this.tools.rosterRoot, entry.name), { recursive: true, force: true });
    }
  }

  /** Serialized by one in-process lock; re-reads the master inside it so a later edit is never exported stale.
   * Writes one file in one directory: tmp, fsync, rename, fsync directory, then records the export. Across processes
   * the rename is atomic (never a torn file) and an export whose version is no longer current exports again. */
  exportRoster(): Promise<LoopRosterExportResultV1> {
    const run = this.#exportChain.then(() => this.#export(), () => this.#export());
    this.#exportChain = run.catch(() => undefined);
    return run;
  }

  async #export(): Promise<LoopRosterExportResultV1> {
    const { state, models } = await this.#read(this.db);
    if (!state) return { exported: false, version: null, message: "roster not seeded" };
    const version = Number(state.version);
    if (models.length === 0) return { exported: false, version, message: "roster empty, export refused" };
    const text = renderLoopRosterV1(models.map(toRow));
    const pending = { exported: false, version,
      message: `export pending (version ${version}, last export ${state.exported_version ?? "none"})` };
    try { await this.checkWithCr(text, models.length); }
    catch (error) { if (error instanceof LoopRosterRefusedV1) return pending; throw error; }
    if (this.sources) return this.db.transaction(async tx => {
      await this.sources!.lockSources(tx);
      const fresh = await this.#read(tx, true);
      if (!fresh.state || String(fresh.state.version) !== String(state.version)
        || renderLoopRosterV1(fresh.models.map(toRow)) !== text) return pending;
      await this.sources!.invalidate(tx);
      const temporary = join(this.tools.rosterRoot, `${loopRosterExportNameV1}.${randomBytes(16).toString("hex")}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await this.faults.afterTemporaryWrite?.();
        await rename(temporary, this.exportPath);
        const directory = await open(this.tools.rosterRoot, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        await this.faults.afterRename?.();
        const recorded = await tx.query(`UPDATE control_loop_roster_state SET exported_version=$2, exported_sha256=$3
          WHERE tenant_id=$1 AND version=$2 RETURNING tenant_id`, [this.scope.tenantId, version, loopRosterSha256V1(text)]);
        if (recorded.rows.length !== 1) throw new Error("selection_source_unavailable");
        return { exported: true, version };
      } finally { await rm(temporary, { force: true }); }
    });
    const temporary = join(this.tools.rosterRoot, `${loopRosterExportNameV1}.${randomBytes(16).toString("hex")}.tmp`);
    let crashed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await this.faults.afterTemporaryWrite?.();
      await rename(temporary, this.exportPath);
      const directory = await open(this.tools.rosterRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.faults.afterRename?.();
    } catch (error) {
      // A test fault stands for a crash: it leaves the temporary file for the next start to remove.
      if (this.faults.afterTemporaryWrite || this.faults.afterRename) { crashed = true; throw error; }
      return pending;
    } finally { if (!crashed) await rm(temporary, { force: true }); }
    const recorded = await this.db.query(`UPDATE control_loop_roster_state SET exported_version=$2, exported_sha256=$3
      WHERE tenant_id=$1 AND version=$2 RETURNING tenant_id`, [this.scope.tenantId, version, loopRosterSha256V1(text)]);
    // The master moved while this export ran, so another process may already have renamed newer bytes that this
    // rename just replaced. Export again from the new master: the last writer is then always current.
    if (recorded.rows.length === 0) return this.#export();
    return { exported: true, version };
  }

  async view(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("roster.read");
      const { state, models } = await this.#read(tx);
      const version = state ? Number(state.version) : null;
      const exportedVersion = state?.exported_version == null ? null : Number(state.exported_version);
      const exported = !!state && exportedVersion === version && !!state.exported_sha256;
      return { seeded: !!state, version, exportedVersion, exported, canEdit: actor.can("roster.manage", undefined, true),
        message: !state ? this.#startMessage ?? "roster not seeded"
          : exported ? undefined : `export pending (version ${version}, last export ${exportedVersion ?? "none"})`,
        models: models.map(model => ({ ...toRow(model), updatedBy: model.updated_by,
          updatedAt: new Date(model.updated_at).toISOString() })) };
    });
  }

  /** Create or edit one row. The candidate is checked by cr before the transaction; the version compare inside it
   * refuses a concurrent edit. A replay of the last command (same key, same request) returns its result. */
  async upsert(identity: VerifiedWebIdentity, name: string, value: unknown, key: string): Promise<LoopRosterEditResultV1> {
    const body = loopRosterUpsertBodySchemaV1.safeParse(value);
    if (!body.success || !nameSchema.safeParse(name).success) throw new WebAccessError("invalid_request");
    const row: LoopRosterRowV1 = { name, ...body.data.row };
    return this.#edit(identity, key, { operation: "upsert", name, body: body.data }, body.data.expectedVersion, () => row);
  }

  async setOn(identity: VerifiedWebIdentity, name: string, value: unknown, key: string): Promise<LoopRosterEditResultV1> {
    const body = loopRosterOnBodySchemaV1.safeParse(value);
    if (!body.success || !nameSchema.safeParse(name).success) throw new WebAccessError("invalid_request");
    const on = body.data.on ? "on" : "off";
    return this.#edit(identity, key, { operation: "on", name, body: body.data }, body.data.expectedVersion, rows => {
      const existing = rows.find(row => row.name === name);
      if (!existing) throw new WebAccessError("not_found");
      return { ...existing, on };
    });
  }

  async #edit(identity: VerifiedWebIdentity, key: string, request: unknown, expectedVersion: number,
    edited: (rows: readonly LoopRosterRowV1[]) => LoopRosterRowV1): Promise<LoopRosterEditResultV1> {
    if (!idempotencyKey.test(key)) throw new WebAccessError("invalid_request");
    const digest = sha256Digest(request);
    const replay = (state: StateRow) => {
      if (state.last_idempotency_key !== key) return undefined;
      if (state.last_request_digest !== digest) throw new WebAccessError("conflict");
      const version = Number(state.version);
      return { replayed: true, version, exported: Number(state.exported_version) === version && !!state.exported_sha256 };
    };
    // Authorize before any process is spawned for this caller.
    const before = await this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("roster.manage", undefined, true);
      const read = await this.#read(tx);
      if (!read.state) throw new WebAccessError("conflict");
      return read;
    });
    const replayed = replay(before.state!);
    if (replayed) return replayed;
    if (Number(before.state!.version) !== expectedVersion) throw new WebAccessError("conflict");
    const change = (rows: readonly LoopRosterRowV1[]) => {
      const target = edited(rows);
      return { target, rows: rows.some(row => row.name === target.name)
        ? rows.map(row => row.name === target.name ? target : row) : [...rows, target] };
    };
    const candidate = change(before.models.map(toRow)).rows;
    let text: string;
    try { text = renderLoopRosterV1(candidate); }
    catch (error) {
      throw new LoopRosterRefusedV1("format", [], error instanceof LoopRosterFormatError && error.reason === "skipped_row"
        ? "a model name may not be blank or start with #: the tools would skip the row" : "a field contains a tab or a line break");
    }
    await this.checkWithCr(text, candidate.length);
    const committed = await this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("roster.manage", undefined, true);
      await this.sources?.lockSources(tx);
      const { state, models } = await this.#read(tx, true);
      if (!state) throw new WebAccessError("conflict");
      const again = replay(state);
      if (again) return again;
      // The candidate cr saw must be exactly what commits: same version, therefore the same base rows.
      const { target, rows } = change(models.map(toRow));
      if (Number(state.version) !== expectedVersion || renderLoopRosterV1(rows) !== text) throw new WebAccessError("conflict");
      await this.sources?.invalidate(tx);
      const at = actor.now, next = expectedVersion + 1;
      if (models.some(model => model.name === target.name)) await tx.query(`UPDATE control_loop_roster_models SET launcher=$3,provider=$4,
        family=$5,model_class=$6,roles=$7,efforts=$8,default_effort=$9,cost=$10,on_off=$11,note=$12,nick=$13,max_build_grade=$14,
        updated_by=$15,updated_at=$16 WHERE tenant_id=$1 AND name=$2`,
      [this.scope.tenantId, target.name, ...columnValues(target), actor.id, at]);
      else await tx.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,
        efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [this.scope.tenantId, target.name, Math.max(0, ...models.map(model => model.position)) + 1, ...columnValues(target), actor.id, at]);
      await tx.query(`UPDATE control_loop_roster_state SET version=$2,last_idempotency_key=$3,last_request_digest=$4,updated_at=$5
        WHERE tenant_id=$1 AND version=$6`, [this.scope.tenantId, next, key, digest, at, expectedVersion]);
      return undefined;
    });
    if (committed) return committed;
    const exported = await this.exportRoster();
    return { replayed: false, version: expectedVersion + 1, exported: exported.exported && exported.version === expectedVersion + 1,
      ...(exported.message ? { message: exported.message } : {}) };
  }
}

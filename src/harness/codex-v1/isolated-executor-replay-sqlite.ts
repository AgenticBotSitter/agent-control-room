import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Digest } from "../../security";
import type { CodexExecutorReplayGuardV1 } from "./isolated-executor-security";
import { assertPrivateSqliteSchemaV1 } from "./private-sqlite-schema";

function preparePrivatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) throw new Error("Codex executor replay database path invalid");
  const uid = process.getuid(); const parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw new Error("Codex executor replay database path invalid");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) {
      throw new Error("Codex executor replay database path invalid");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
}

/** Broker-private, restart-safe replay consumption. Raw nonces and receipt IDs are never stored. */
export class SqliteCodexExecutorReplayGuardV1 implements CodexExecutorReplayGuardV1 {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly maximumEntries = 100_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000) throw new Error("Codex executor replay limit invalid");
    preparePrivatePath(path);
    this.db = new DatabaseSync(path);
    const schemaVersion = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (schemaVersion !== 0 && schemaVersion !== 1) { this.db.close(); throw new Error("Codex executor replay schema unsupported"); }
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codex_executor_replay (
        value_digest TEXT PRIMARY KEY CHECK(length(value_digest)=71), consumed_at_ms INTEGER NOT NULL
      );`);
    if (schemaVersion === 0) this.db.exec("PRAGMA user_version=1");
    try { assertPrivateSqliteSchemaV1(this.db, ["table:codex_executor_replay"], {
      codex_executor_replay: [
        { name: "value_digest", type: "TEXT", notnull: 0, pk: 1 },
        { name: "consumed_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
      ],
    }, {
      codex_executor_replay: "CREATE TABLE codex_executor_replay (value_digest TEXT PRIMARY KEY CHECK(length(value_digest)=71), consumed_at_ms INTEGER NOT NULL)",
    }); } catch (error) { this.db.close(); throw error; }
  }

  consumeOnce(...values: string[]): void {
    if (values.length < 1 || values.length > 8 || values.some((value) => typeof value !== "string" || value.length < 3 || value.length > 512)) {
      throw new Error("Codex executor replay value invalid");
    }
    const digests = values.map((value) => sha256Digest(value));
    if (new Set(digests).size !== digests.length) throw new Error("Codex executor authentication replayed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_executor_replay").get() as { count: number }).count;
      if (current + digests.length > this.maximumEntries) throw new Error("Codex executor replay capacity exhausted");
      const find = this.db.prepare("SELECT 1 FROM codex_executor_replay WHERE value_digest=?");
      if (digests.some((digest) => Boolean(find.get(digest)))) throw new Error("Codex executor authentication replayed");
      const insert = this.db.prepare("INSERT INTO codex_executor_replay(value_digest,consumed_at_ms) VALUES (?,?)");
      const consumedAt = Date.now();
      for (const digest of digests) insert.run(digest, consumedAt);
      if (digests.some((digest) => !find.get(digest))) throw new Error("Codex executor replay persistence invalid");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  evidence(): { consumedDigests: number; maximumEntries: number } {
    const consumedDigests = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_executor_replay").get() as { count: number }).count;
    return { consumedDigests, maximumEntries: this.maximumEntries };
  }

  closeDatabase(): void { this.db.close(); }
}

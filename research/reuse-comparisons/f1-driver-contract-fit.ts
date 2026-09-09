// Bounded, per-process synthetic comparison. No production configuration changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { boundPrivateDatabase } from '../../src/web/v1/bounded-database.ts';
import { privatePostgresOptions } from '../../src/web/v1/private-postgres.ts';
const [root, socket, requestedMode, suite] = process.argv.slice(2);
const uncast = requestedMode === 'uncast' || suite === 'uncast';
const mode = requestedMode === 'uncast' ? undefined : requestedMode;
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
const modes = uncast ? ['plain', 'typed', 'node-pg'] : ['plain', 'typed', 'node-pg', 'private-cold', 'types-cold'];
const emit = (value: object) => console.log(JSON.stringify(value));
if (!mode) {
  const exec = promisify(execFile), results: object[] = [];
  for (const candidate of modes) {
    const started = Date.now();
    try {
      const result = await exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(import.meta.url), root, socket, candidate, ...(uncast ? ['uncast'] : [])],
      { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: dirname(socket) }, timeout: 8000, maxBuffer: 32768 });
      const receipt = { candidate, exit: 0, elapsedMs: Date.now() - started, stdout: result.stdout };
      results.push(receipt); emit(receipt);
    } catch (error) {
      const e = error as Error & {code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string};
      const receipt = { candidate, exit: e.code ?? null, elapsedMs: Date.now() - started,
        killed: e.killed === true, signal: e.signal ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      results.push(receipt); emit(receipt);
    }
  }
  emit({ comparisonFinished: true, cases: results.length, scope: 'per-process observations; individual failures remain failures' });
} else {
  assert.ok(modes.includes(mode));
  const { Pool } = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'))('pg');
  const pool = mode === 'node-pg' ? new Pool({host: socket, port: 65433, user: 'f1_owner', database: 'postgres',
    password: '', max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000}) : undefined;
  // Actual production option builder, with only synthetic target and fixture limits
  // substituted. Unix PG18 is deliberately NOT production loopback PG17 acceptance.
  const options = privatePostgresOptions({host: '127.0.0.1', port: 65433, database: 'postgres',
    username: 'f1_owner', password: 'synthetic-only', majorVersion: 17});
  const sql = pool ? undefined : postgres({...options, host: socket, password: '', max: 1,
    fetch_types: mode !== 'private-cold', connect_timeout: 2});
  emit({ stage: 'constructed', mode, fetchTypes: sql ? mode !== 'private-cold' : null });
  const db = boundPrivateDatabase({
    async acquire() {
      emit({ stage: 'acquire-start' });
      if (pool) {
        const lease = await pool.connect(); emit({ stage: 'acquired' });
        return { query: (statement: string, values: unknown[]) => lease.query(statement, values), release: () => lease.release() };
      }
      const lease = await sql!.reserve(); emit({ stage: 'acquired' });
      return {
        async query<T>(statement: string, values: unknown[] = []) {
          // Candidate public typed binding, not a hand-written serializer. Each
          // tested SQL context explicitly casts its parameter to the desired type.
          const bound = mode === 'typed' ? values.map(v => typeof v === 'string' ? sql!.typed(v, 25) : v) : values;
          const rows = await lease.unsafe(statement, bound as never[], { prepare: false, simple: false });
          return { rows: rows as unknown as T[] };
        }, release: () => lease.release(),
      };
    }, terminate: () => pool ? pool.end() : sql!.end({ timeout: 0 }),
  });
  try {
    if (mode.endsWith('cold')) {
      assert.equal((await db.client.query<{v: number}>('SELECT 1::int AS v')).rows[0].v, 1);
      emit({ passed: 'cold-acquire-query' });
      assert.equal((await db.client.query<{v: number}>('SELECT 2::int AS v')).rows[0].v, 2);
      emit({ passed: 'release-reacquire' });
    } else {
      const cases = uncast ? [
        // Same operator/parameter typing as actual outbox and UUID recovery
        // predicates; synthetic rows, not full canonical store acceptance.
        ['uncast-timestamp', "SELECT available_at <= $1 AS value FROM (VALUES ('2026-01-01T00:00:00Z'::timestamptz)) x(available_at)", ['2026-01-02T00:00:00Z'], [{value:true}]],
        ['uncast-uuid', "SELECT id=$1 AS value FROM (VALUES ('00000000-0000-4000-8000-000000000001'::uuid)) x(id)", ['00000000-0000-4000-8000-000000000001'], [{value:true}]],
      ] as const : [
        ['array-json', 'SELECT value FROM json_to_recordset($1::json) AS x(value text)', [JSON.stringify([{value:'ok'}])], [{value:'ok'}]],
        ['object-jsonb', 'SELECT $1::jsonb AS value', [JSON.stringify({n:2})], [{value:{n:2}}]],
        ['string-json', 'SELECT $1::json AS value', [JSON.stringify('literal')], [{value:'literal'}]],
        ['object-input', 'SELECT $1::jsonb AS value', [{n:3}], [{value:{n:3}}]],
        ['text', 'SELECT $1::text AS value', ['quoted\"\\text'], [{value:'quoted\"\\text'}]],
        ['uuid', 'SELECT $1::uuid AS value', ['00000000-0000-4000-8000-000000000001'], [{value:'00000000-0000-4000-8000-000000000001'}]],
        ['array', 'SELECT $1::text[] AS value', [['a','b']], [{value:['a','b']}]],
        ['null', 'SELECT $1::jsonb AS value', [null], [{value:null}]],
      ] as const;
      for (const [name, statement, values, expected] of cases) {
        emit({ stage: 'query-start', name });
        try {
          const result = await db.client.query(statement, [...values]);
          // Postgres.js returns an Array subclass; compare every returned row,
          // not the collection prototype, which DatabaseSession does not promise.
          assert.deepEqual([...result.rows], expected); emit({ passed: name });
        } catch (error) { emit({ failed: name, message: (error as Error).message }); }
      }
      if (!uncast) {
      await db.client.query('CREATE TEMP TABLE driver_contract (value jsonb)');
      await assert.rejects(db.client.transactionWithPreCommitCheck(async tx => {
        await tx.query('INSERT INTO driver_contract VALUES ($1::jsonb)', [JSON.stringify({rollback:true})]);
      }, () => { throw new Error('synthetic-precommit-reject'); }), /synthetic-precommit-reject/);
      assert.deepEqual([...(await db.client.query('SELECT * FROM driver_contract')).rows], []);
      emit({ passed: 'precommit-rollback' });
      }
    }
  } finally { emit({ stage: 'close-start' }); await db.close(); emit({ stage: 'closed' }); }
}

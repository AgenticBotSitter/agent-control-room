// Actual driver shutdown under CR bounds; inert queries on an owned cluster only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { boundPrivateDatabase, privateDatabaseLimits } from '../../src/web/v1/bounded-database.ts';
const [root, socket] = process.argv.slice(2);
const selected = process.argv[4];
assert.ok(selected === undefined || selected === 'pg-release-destroy');
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
const { Pool, Client } = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'))('pg');
const options = {host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  connectionTimeoutMillis: 2000, statement_timeout: 5000};
const observer = new Client(options);
const emit = (value: object) => console.log(JSON.stringify(value));
await observer.connect();
try {
  for (const mode of selected ? [selected] : ['postgres-end', 'pg-pool-end', 'pg-tracked-client-end']) {
    const app = `fixture-${mode}`, leases = new Set<InstanceType<typeof Client>>();
    const pending = new Set<Promise<InstanceType<typeof Client>>>();
    const sql = mode === 'postgres-end' ? postgres({host: socket, port: 65433, username: 'f1_owner',
      database: 'postgres', password: '', max: 1, fetch_types: true, prepare: false,
      connection: {application_name: app, statement_timeout: 5000}}) : undefined;
    const pool = sql ? undefined : new Pool({...options, max: 1, application_name: app,
      ...(mode === 'pg-release-destroy' ? {connectionTimeoutMillis: 200} : {})});
    pool?.on('error', () => {});
    let terminationCalls = 0, issued = 0, acquired = 0, released = 0;
    const driver = {
      async acquire() {
        if (sql) {
          const lease = await sql.reserve(); acquired++;
          return {async query<T>(statement: string, values: unknown[] = []) {
            issued++; return {rows: await lease.unsafe(statement, values as never[], {prepare:false,simple:false}) as unknown as T[]};
          }, release() {released++; lease.release();}};
        }
        const checkout = pool!.connect(); pending.add(checkout);
        let lease;
        try {lease = await checkout;} finally {pending.delete(checkout);}
        acquired++; leases.add(lease); lease.on('error', () => {});
        return {async query(statement: string, values: unknown[] = []) {issued++; return lease.query(statement, values);},
          release() {if (leases.delete(lease)) {released++; lease.release();}}};
      },
      async terminate() {
        terminationCalls++;
        if (sql) return sql.end({timeout: 0});
        if (mode === 'pg-release-destroy') {
          const ended = pool!.end(); // stop new pool admission before destroying leases
          for (const lease of leases) {leases.delete(lease); released++; lease.release(true);}
          await Promise.allSettled([...pending]);
          await ended;
          emit({mode, pendingAfterTerminate: pending.size, poolWaiting: pool!.waitingCount,
            poolTotal: pool!.totalCount});
          return;
        }
        if (mode === 'pg-tracked-client-end') {
          // Maintained Client.end destroys a busy connection; await it before pool
          // closure. This is research composition, not a reviewed production driver.
          await Promise.all([...leases].map(lease => lease.end()));
        }
        await pool!.end();
      },
    };
    const db = boundPrivateDatabase(driver, {...privateDatabaseLimits, closeMs: 500});
    const settle = (p: Promise<unknown>) => p.then(() => ({resolved:true}), error => ({resolved:false, error:String(error.message)}));
    let first: ReturnType<typeof settle> | undefined, queued: ReturnType<typeof settle> | undefined;
    try {
      first = settle(db.client.query('SELECT pg_sleep(3)'));
      // Observe server execution, not a timing guess, before adding the queued lease.
      const deadline = Date.now() + 2500;
      for (;;) {
        const result = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND state=$2', [app, 'active']);
        if (result.rows[0].n === 1) break;
        assert.ok(Date.now() < deadline, 'server never observed active query'); await delay(20);
      }
      queued = settle(db.client.query('SELECT 42 AS should_not_run'));
      await delay(20);
      const began = Date.now();
      const close = await settle(db.close());
      const closeMs = Date.now() - began;
      const outcomes = await Promise.all([first, queued]);
      const sessions = (await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1', [app])).rows[0].n;
      assert.equal(db.isAvailable(), false);
      await assert.rejects(db.client.query('SELECT 99'), /database_unavailable/);
      emit({mode, close, closeMs, outcomes, sessionsAfterClose: sessions, issued, acquired, released,
        terminationCalls, futureWorkRefused:true});
    } finally {
      // Explicit owned-client cleanup even when candidate termination is insufficient.
      // This cleanup is not counted as the candidate's successful shutdown.
      if (sql) await sql.end({timeout: 0});
      else {await Promise.all([...leases].map(lease => lease.end())); if (!pool!.ending) await pool!.end();}
      await Promise.all([first, queued].filter(Boolean));
      // Cleanup observation may outlast the inert three-second server statement.
      // The recorded sessionsAfterClose above remains the candidate's result.
      const deadline = Date.now() + 5500;
      for (;;) {
        const sessions = (await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1', [app])).rows[0].n;
        if (sessions === 0) break;
        assert.ok(Date.now() < deadline, 'owned driver sessions remain'); await delay(20);
      }
      emit({mode, cleanupSessionsAbsent:true});
    }
  }
} finally {await observer.end();}

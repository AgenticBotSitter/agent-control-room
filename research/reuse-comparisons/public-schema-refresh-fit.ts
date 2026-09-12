// Disposable, in-memory development evidence only; no service or production DB.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { adaptPglite } from '../../src/persistence/database.ts';
import { readPrivateWebSchemaDigest } from '../../src/web/v1/private-database-preflight.ts';

const root = '/private/tmp/cr-public-refresh.3pzcHT/repo';
const files = (await readdir(`${root}/db/migrations`)).filter(f => f.endsWith('.sql')).sort();
assert.equal(files.length, 64);
assert.ok(files.includes('0025_cr9a_external_content_sync.sql'));
assert.ok(files.includes('0026_cr9a_external_content_placement.sql'));
assert.ok(files.every(f => !f.includes('content_blooms')));
const publicSource = await readFile(`${root}/src/web/v1/private-database-preflight.ts`, 'utf8');
const privateSource = await readFile('src/web/v1/private-database-preflight.ts', 'utf8');
const body = (source: string) => source.split('export async function readPrivateWebSchemaDigest')[1].split('/** Trusted bootstrap')[0].trim();
assert.equal(body(publicSource), body(privateSource), 'Use precisely the same catalog algorithm');
const db = new PGlite();
const client = adaptPglite(db);
const inputs = [];
try {
  let priorDigest = '';
  for (const [index, file] of files.entries()) {
    const sql = await readFile(`${root}/db/migrations/${file}`, 'utf8');
    inputs.push({file,sha256:createHash('sha256').update(sql).digest('hex')});
    await db.exec(sql);
    if (index === 57) {
      priorDigest = await readPrivateWebSchemaDigest(client);
      assert.equal(priorDigest, '1d03ff658c8c413abebca42b783f3bd7e18320b51c24e35fb3c96c8cea712199');
    }
  }
  const refreshedDigest = await readPrivateWebSchemaDigest(client);
  assert.notEqual(refreshedDigest, priorDigest);
  const tables = await db.query<{name:string}>('SELECT tablename AS name FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename');
  assert.equal(tables.rows.length, 145);
  assert.ok(tables.rows.every(row=>!row.name.includes('content_blooms')));
  console.log(JSON.stringify({kind:'public-schema-refresh-development-evidence',priorDigest,refreshedDigest,tables:tables.rows.length,inputs,productionOrRestoreAcceptance:false}));
} finally { await db.close(); }

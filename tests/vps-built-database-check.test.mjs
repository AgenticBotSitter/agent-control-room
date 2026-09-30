import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../dist-vps/server/index.js';
import { createPrivateWebDatabaseCheck } from '../dist-vps/server/bootstrap.js';
import { createPrivateWebDatabaseCheck as createSourcePrivateWebDatabaseCheck } from '../src/web/v1/private-startup.ts';
import { limitedWebFixture, startupConfig } from './helpers/web-startup.ts';
import { now, request } from './helpers/web-foundation.ts';

test('compiled database-only check closes its restricted pool without installing the compiled website', async () => {
  assert.equal((await handler(request())).status, 503);
  const f = await limitedWebFixture();
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => f.pool, clock: () => now });
  const result = await check(startupConfig);
  assert.equal(result.databasePreflight, 'passed'); assert.equal(result.databaseClosed, true);
  assert.equal(result.applicationInstalled, false); assert.equal(result.listenerStarted, false);
  assert.equal(result.backupVerified, false); assert.equal(result.productionReady, false);
  assert.equal(f.closes(), 1);
  assert.equal((await handler(request())).status, 503);
});

// The fixture's database passes (above); each case below changes one function
// fact as the migration superuser and the same check must refuse it. The fleet
// redemption case is the shape PGlite produces before the fixture hands the
// boundary to the production owner: a definer function running as a superuser.
for (const [name, sql] of [
  ["an unknown definer-rights function",
    `CREATE FUNCTION public.stray_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER
       SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;
     REVOKE ALL ON FUNCTION public.stray_definer() FROM PUBLIC`],
  ["an unknown function the web role can execute",
    `CREATE FUNCTION public.stray_callable() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
     GRANT EXECUTE ON FUNCTION public.stray_callable() TO control_room_private_web`],
  ["the fleet redemption boundary owned by the migration superuser",
    "ALTER FUNCTION redeem_fleet_enrollment(text,text,text,text,timestamptz) OWNER TO CURRENT_USER"],
  ["the fleet redemption boundary executable by the web role",
    "GRANT EXECUTE ON FUNCTION redeem_fleet_enrollment(text,text,text,text,timestamptz) TO control_room_private_web"],
  ["the agent-review commit executable by the web role",
    "GRANT EXECUTE ON FUNCTION commit_agent_review(text,jsonb,jsonb,bytea) TO control_room_private_web"],
  ["the agent-review plan read executable by PUBLIC",
    "GRANT EXECUTE ON FUNCTION read_agent_review_plan(text) TO PUBLIC"],
]) test(`database-only check refuses ${name}`, async () => {
  const f = await limitedWebFixture();
  await f.db.exec(`SET SESSION AUTHORIZATION postgres; ${sql}; SET SESSION AUTHORIZATION web_test`);
  const check = createSourcePrivateWebDatabaseCheck({ openDatabase: () => f.pool, clock: () => now });
  await assert.rejects(check(startupConfig), /^Error: private_database_check_failed$/);
  assert.equal(f.closes(), 1);
});

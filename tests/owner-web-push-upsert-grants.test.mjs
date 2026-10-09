import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFileSync(resolve(ROOT,path),"utf8");
// Runner inventory is bound to the real Mac-local compositions; the SQL being
// checked cannot supply its own expected columns or authority.
const RUNNERS = {
  owner_web_push_subscriptions: { method: "subscribe", columns: ["p256dh", "auth", "expires_at", "updated_at"] },
  owner_web_push_deliveries: { method: "reserve", columns: ["state", "status_code", "completed_at"] },
};
function inventory(source) {
  const writes = [...source.matchAll(/INSERT INTO\s+(\w+)([^`]*?ON CONFLICT[^`]*?DO UPDATE[^`]*)/g)];
  for (const [,table] of writes) assert.ok(Object.hasOwn(RUNNERS,table), `unclassified web-push upsert:${table}`);
  return writes.map(([,table,sql]) => ({ table, columns: [...sql.split(/DO UPDATE\s+SET/i)[1].split(/\bWHERE\b|\bRETURNING\b/i)[0]
    .matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map(match=>match[1]).sort() }));
}
function freshColumns(table) {
  const sql = read("db/roles/private_web_roles.sql").replace(/--[^\n]*/g,"");
  return [...sql.matchAll(/GRANT UPDATE\s*\(([^)]*)\)\s+ON\s+(\w+)\s+TO control_room_private_web/g)]
    .filter(([, ,name])=>name===table).flatMap(([,columns])=>columns.split(",").map(x=>x.trim())).sort();
}
const source = () => read("src/web-push/v1/postgres-store.ts");

test("CR-E075 upsert inventory refuses an unclassified future write", () => {
  const writes=inventory(source()); assert.deepEqual(writes.map(x=>x.table).sort(),Object.keys(RUNNERS).sort());
  const web=read("src/web/v1/mac-local-web-process.ts"), serving=read("src/web/v1/mac-local-serving.ts");
  assert.match(web,/store: new PostgresOwnerPushStoreV1\(options\.database\.client\)/);
  assert.match(serving,/new PostgresOwnerPushStoreV1/);
  assert.throws(()=>inventory(source()+"\nINSERT INTO unknown_push_store(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=2`"),
    /unclassified web-push upsert:unknown_push_store/,"unknown writes cannot silently escape the runner inventory");
});
test("CR-E075 subscription upsert has exactly four fresh UPDATE columns", () => {
  const expected=["auth","expires_at","p256dh","updated_at"];
  assert.deepEqual(inventory(source()).find(x=>x.table==="owner_web_push_subscriptions").columns,expected);
  assert.deepEqual(freshColumns("owner_web_push_subscriptions"),expected,"subscription runner requires the four-column grant");
  assert.doesNotMatch(read("db/roles/private_web_roles.sql"),/GRANT UPDATE ON owner_web_push_subscriptions/);
});
test("delivery upsert preserves its independently declared three-column grant", () => {
  const expected=["completed_at","state","status_code"];
  assert.deepEqual(inventory(source()).find(x=>x.table==="owner_web_push_deliveries").columns,expected);
  assert.deepEqual(freshColumns("owner_web_push_deliveries"),expected);
});
test("CR-E075 subscription fresh migration generated and startup declarations agree", () => {
  const columns=["auth","expires_at","p256dh","updated_at"];
  assert.match(read("src/web/v1/private-database-preflight.ts"),/owner_web_push_subscriptions: \["p256dh", "auth", "expires_at", "updated_at"\]/);
  const migration=read("db/migrations/0299_owner_web_push_subscription_update_grant.sql");
  assert.match(migration,/GRANT UPDATE \(p256dh, auth, expires_at, updated_at\) ON owner_web_push_subscriptions TO control_room_private_web/);
  assert.match(read("db/down/0299_owner_web_push_subscription_update_grant.sql"),/REVOKE UPDATE \(p256dh, auth, expires_at, updated_at\) ON owner_web_push_subscriptions FROM control_room_private_web/);
  const desired=JSON.parse(read("deploy/postgres/desired-grants.json")).desired;
  assert.deepEqual(desired.filter(x=>x.startsWith("control_room_private_web|table|public.owner_web_push_subscriptions|")&&x.includes("|UPDATE|")),
    columns.map(c=>`control_room_private_web|table|public.owner_web_push_subscriptions|${c}|UPDATE|plain`));
});

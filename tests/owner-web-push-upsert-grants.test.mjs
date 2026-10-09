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
  const name = '(?:"[^"]+"|\\w+)';
  const writes = [...source.matchAll(new RegExp(`INSERT\\s+INTO\\s+(${name}(?:\\s*\\.\\s*${name})?)([^\`]*?ON\\s+CONFLICT[^\`]*?DO\\s+UPDATE[^\`]*)`, "gi"))]
    .map(([, written, sql]) => [written.replace(/"/g, "").replace(/\s+/g, "").replace(/^public\./i, "").toLowerCase(), sql]);
  for (const [table] of writes) assert.ok(Object.hasOwn(RUNNERS,table), `unclassified web-push upsert:${table}`);
  return writes.map(([table,sql]) => ({ table, columns: [...sql.split(/DO\s+UPDATE\s+SET/i)[1].split(/\bWHERE\b|\bRETURNING\b/i)[0]
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
test("CR-E075 upsert inventory refuses spelling variants of an unknown write", () => {
  const upsert = head => `\n${head} VALUES(1)\n  ON CONFLICT(id) DO UPDATE SET id=2\``;
  for (const [name, sql] of [
    ["lowercase", upsert("insert into unknown_push_store(id)")],
    ["mixed case", upsert("Insert Into unknown_push_store(id)")],
    ["newline after INTO", upsert("INSERT INTO\n    unknown_push_store(id)")],
    ["quoted", upsert('INSERT INTO "unknown_push_store"(id)')],
    ["schema-qualified", upsert("INSERT INTO public.unknown_push_store(id)")],
    ["quoted schema-qualified", upsert('INSERT INTO "public"."unknown_push_store"(id)')],
    ["lowercase on conflict", "\ninsert into unknown_push_store(id) values(1) on conflict(id) do update set id=2`"],
  ]) assert.throws(() => inventory(source() + sql), /unclassified web-push upsert:unknown_push_store/, `${name} unknown upsert must be refused`);
  assert.throws(() => inventory(source() + upsert("INSERT INTO other_schema.unknown_push_store(id)")),
    /unclassified web-push upsert:other_schema\.unknown_push_store/, "a different schema is never folded into public");
  assert.deepEqual(inventory(source()).map(x => x.table).sort(), Object.keys(RUNNERS).sort(), "the real store still classifies");
  assert.deepEqual(inventory(source() + upsert("INSERT INTO public.owner_web_push_deliveries(id)")).filter(x => x.table === "owner_web_push_deliveries").length, 2,
    "a qualified spelling of a classified table is still counted");
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

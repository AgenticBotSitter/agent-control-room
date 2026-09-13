import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "../src/security";
import { assertLinuxUnixOwnerBootstrapPeerV1 } from "../src/web/v1/owner-bootstrap-ceremony";
import { origin, token, trust } from "./helpers/web-foundation";
import { prepared } from "./owner-bootstrap-ceremony-helper";

test("Linux Unix control proof emits one bounded code only to the injected attached operator", async t => {
  const x = await prepared(); t.after(() => x.raw.close());
  const evidence = await x.ceremony.arm(x.attempt());
  assert.match(x.code(), /^[A-Za-z0-9_-]{43}$/); assert.equal(JSON.stringify(evidence).includes(x.code()), false);
  await assert.rejects(x.ceremony.arm(x.attempt()), /unavailable/);
  for (const invalid of [x.attempt({ transport: "tcp" as "unix" }), x.attempt({ peer: { uid: 1001, pid: 42 } }),
    x.attempt({ directory: { kind: "directory", path: "/run/user/1000/control-room", uid: 1000, mode: 0o750, linkCount: 2 } }),
    x.attempt({ directory: { kind: "directory", path: "/run/user/1000/control-room", uid: 1000, mode: 0o700, linkCount: 1 } }),
    x.attempt({ socket: { kind: "socket", path: "/run/user/1000/control-room/owner-bootstrap.sock", uid: 1000, mode: 0o660, linkCount: 1 } })]) {
    assert.throws(() => assertLinuxUnixOwnerBootstrapPeerV1(invalid, {
      runtimeDirectory: "/run/user/1000/control-room", socketPath: "/run/user/1000/control-room/owner-bootstrap.sock",
      serviceUid: 1000, operatorUid: 1000,
    }), /unavailable/);
  }
  const raced = await prepared(); t.after(() => raced.raw.close());
  const outcomes = await Promise.allSettled([raced.ceremony.arm(raced.attempt()), raced.ceremony.arm(raced.attempt())]);
  assert.deepEqual(outcomes.map(value => value.status).sort(), ["fulfilled", "rejected"]);

  const ordered = await prepared(); t.after(() => ordered.raw.close()); let duringDelivery = 0;
  await ordered.ceremony.arm(ordered.attempt({ async writeCode(value) {
    duringDelivery = (await ordered.ceremony.route(ordered.browser(value)))?.status ?? 0;
  } }));
  assert.equal(duringDelivery, 503);
  assert.equal((await ordered.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "0");
});

test("verified assertion and exact code create one owner while races, replay, and body identity injection fail", async t => {
  const x = await prepared(); t.after(() => x.raw.close()); await x.ceremony.arm(x.attempt());
  assert.equal((await x.ceremony.route(new Request(`${origin}/api/v1/owner-bootstrap`, { method: "POST",
    headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": token() },
    body: JSON.stringify({ code: x.code(), subject: "attacker" }) })))?.status, 503);
  assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "0");
  const [a, b] = await Promise.all([x.ceremony.route(x.browser()), x.ceremony.route(x.browser())]);
  assert.deepEqual([a?.status, b?.status].sort(), [201, 503]);
  const identity = (await x.base.query<{ auth_provider: string; auth_subject_digest: string }>(
    "SELECT auth_provider,auth_subject_digest FROM control_identities")).rows;
  assert.equal(identity.length, 1); assert.equal(identity[0]!.auth_provider, trust.issuer);
  assert.equal(identity[0]!.auth_subject_digest, sha256Digest({ provider: trust.issuer, subject: "test-owner" }));
  assert.equal(JSON.stringify(identity).includes(x.code()), false);
  assert.equal(JSON.stringify(identity).includes("test-owner"), false);
  assert.equal(await x.ceremony.route(x.browser()).then(value => value?.status), 404);
  assert.equal(x.ceremony.isBootstrapOnly(), false);
});

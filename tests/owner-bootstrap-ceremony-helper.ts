import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { createOwnerBootstrapCeremonyV1, type LinuxUnixOwnerBootstrapControlAttemptV1,
  type OwnerBootstrapLifecycleStoreV1 } from "../src/web/v1/owner-bootstrap-ceremony";
import { now, origin, token, trust } from "./helpers/web-foundation";

export function syntheticLifecycle(initial: "available" | "claimed" | "complete" = "available"): OwnerBootstrapLifecycleStoreV1 {
  let state = initial;
  return { async inspect() { return state; }, async claim() {
    if (state !== "available") throw new Error("synthetic_lifecycle_claimed"); state = "claimed";
  }, async complete() { if (state !== "claimed") throw new Error("synthetic_lifecycle_unclaimed"); state = "complete"; } };
}

export async function prepared(database?: (base: DatabaseClient) => DatabaseClient,
  lifecycle: OwnerBootstrapLifecycleStoreV1 = syntheticLifecycle(),
  options: { existingOwner?: boolean; random?: (size: number) => Uint8Array } = {}) {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(value => value.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:web','Bootstrap tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Bootstrap workspace')");
  if (options.existingOwner) await raw.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:existing','tenant:web','human','Existing','provider:test',$1,'active',$2,$2)`,
    [sha256Digest("existing"), new Date(now).toISOString()]);
  const base = adaptPglite(raw), db = database?.(base) ?? base;
  const name = (await base.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
  let clock = now, code = "";
  const ceremony = createOwnerBootstrapCeremonyV1({ origin, trust, database: db,
    runtimeDirectory: "/run/user/1000/control-room", socketPath: "/run/user/1000/control-room/owner-bootstrap.sock",
    serviceUid: 1000, operatorUid: 1000, clock: () => clock,
    random: options.random ?? (() => new Uint8Array(32).fill(7)),
    controlDeadlineMs: 20, lifecycle, owner: { databaseName: name, tenantId: "tenant:web", workspaceId: "workspace:web",
      identityId: "identity:owner", grantId: "grant:owner", displayName: "First owner",
      expectedOwnerSubjectDigest: sha256Digest({ provider: trust.issuer, subject: "test-owner" }) } });
  const attempt = (changes: Partial<LinuxUnixOwnerBootstrapControlAttemptV1> = {}): LinuxUnixOwnerBootstrapControlAttemptV1 => ({
    transport: "unix", platform: "linux", runtimeDirectory: "/run/user/1000/control-room",
    socketPath: "/run/user/1000/control-room/owner-bootstrap.sock", serviceUid: 1000, operatorUid: 1000,
    directory: { kind: "directory", path: "/run/user/1000/control-room", uid: 1000, mode: 0o700, linkCount: 2 },
    socket: { kind: "socket", path: "/run/user/1000/control-room/owner-bootstrap.sock", uid: 1000, mode: 0o600, linkCount: 1 },
    peer: { uid: 1000, pid: 42 }, requestBytes: Buffer.from('{"operation":"arm"}'),
    async writeCode(value) { code = value; }, async close() {}, ...changes,
  });
  const browser = (value = code, jwt = token(), extra: Record<string, unknown> = {}) => new Request(`${origin}/api/v1/owner-bootstrap`, {
    method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      "cf-access-jwt-assertion": jwt }, body: JSON.stringify({ code: value, ...extra }),
  });
  return { raw, base, ceremony, attempt, browser, code: () => code, setClock(value: number) { clock = value; } };
}

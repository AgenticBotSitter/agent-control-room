import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { mkdtemp, mkdir, symlink, realpath, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectOwnerAgentPath, createOwnerAgentSocketPort } from "../src/harness/v1/native-owner-agent-ports";

test("native metadata inspector accepts owned directory and refuses aliases and missing paths", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cr-owner-path-")));
  try {
    const directory = join(root, "agent"); await mkdir(directory, { mode: 0o700 });
    const inspected = await inspectOwnerAgentPath(directory);
    assert.equal(inspected.kind, "directory"); assert.equal(inspected.canonicalPath, directory);
    assert.equal(inspected.uid, process.getuid!()); assert.equal(inspected.mode & 0o777, 0o700);
    const alias = join(root, "alias"); await symlink(directory, alias);
    await assert.rejects(inspectOwnerAgentPath(alias), /owner_agent_endpoint_unavailable/);
    await assert.rejects(inspectOwnerAgentPath(`${alias}/../agent`));
    await assert.rejects(inspectOwnerAgentPath(join(root, "absent")));
  } finally { await rm(root, { recursive: true }); await assert.rejects(lstat(root), { code: "ENOENT" }); }
});

test("socket port uses exact supplied path and reports connection failure without a real socket", async () => {
  for (const mode of ["connect", "error", "close", "end", "throw"] as const) {
    let constructions = 0, destroys = 0, connects = 0;
    const fake = Object.assign(new EventEmitter(), {
      connect(path: string) { connects++; assert.equal(path, "/synthetic/agent/socket");
        if (mode === "throw") throw new Error("synthetic private endpoint"); return this; },
      destroy() { destroys++; return this; },
    });
    const open = createOwnerAgentSocketPort(() => { constructions++; return fake as unknown as Socket; });
    assert.equal(constructions, 0);
    if (mode === "throw") { assert.throws(() => open("/synthetic/agent/socket"), /owner_signature_unavailable/); assert.equal(destroys, 1); }
    else {
      const connection = open("/synthetic/agent/socket");
      if (mode === "connect") { fake.emit("connect"); await connection.connected; }
      else { const rejected = assert.rejects(connection.connected, /owner_signature_unavailable/);
        fake.emit(mode, new Error("synthetic private endpoint")); await rejected; }
    }
    assert.equal(constructions, 1); assert.equal(connects, 1);
  }
});

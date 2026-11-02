import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout.ts";
import { pgSocketOptionV1, pgConninfoValueV1, shellArgumentV1, pgCtlInvocationV1 } from "../src/pg-runtime/v1/pg-path-quoting.mjs";
import { parseKeywordValueTarget } from "../deploy/postgres/evidence.mjs";
import { withRealPostgres } from "./support/attack-kit/real-postgres.ts";

const bin = process.env.PG_BIN;
const accounts = { database: "fixture_db", migrator: "fixture_migrate", deployer: "fixture_deploy" };

test("PostgreSQL 17 parses installer socket paths with spaces, quotes and backslashes", { skip: !bin }, async () => {
  const root = await mkdtemp("/tmp/pg-path-");
  try {
    assert.match(execFileSync(join(bin!, "postgres"), ["--version"], { encoding: "utf8" }), /PostgreSQL\) 17\./u);
    for (const suffix of ["space dir", "quote' dir", 'double" dir', 'comma,back\\ dir']) {
      const pgRoot = join(root, suffix);
      const layout = planPgClusterLayoutV1({ pgRoot, dataId: "data-A", runtimeDirectory: join(root, "runtime"), accounts });
      await mkdir(layout.dataDirectory, { recursive: true });
      await writeFile(join(layout.dataDirectory, "postgresql.conf"), layout.postgresqlConf);
      const value = execFileSync(join(bin!, "postgres"), ["-D", layout.dataDirectory, "-C", "unix_socket_directories"],
        { encoding: "utf8", timeout: 120_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim();
      const expected = `"${layout.socketDirectory.replaceAll('"', '""')}"`;
      assert.equal(value, expected);
      // Exercise the real shell layer pg_ctl uses, then PostgreSQL's GUC parser.
      const optionValue = execFileSync("/bin/sh", ["-c",
        `exec "$1" -D "$2" ${pgSocketOptionV1(layout.socketDirectory)} -C unix_socket_directories`,
        "pg-path-test", join(bin!, "postgres"), layout.dataDirectory],
        { encoding: "utf8", timeout: 120_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim();
      assert.equal(optionValue, expected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const suffix of ["space dir", "quote' dir", 'double" dir', 'comma,back\\ dir']) {
  test(`PostgreSQL 17 starts and stops with data/socket path ${suffix}`, { skip: !bin }, async () => {
    const root = await mkdtemp("/tmp/pg-path-");
    const previous = [process.env.ATTACK_KIT_RUN_ROOT, process.env.ATTACK_KIT_SOCKET_ROOT];
    const directory = join(root, suffix);
    await mkdir(directory);
    process.env.ATTACK_KIT_RUN_ROOT = directory;
    process.env.ATTACK_KIT_SOCKET_ROOT = directory;
    let data: string | undefined, socket: string | undefined;
    try {
      await withRealPostgres(async pg => {
        data = pg.dataDirectory; socket = pg.socketDirectory;
        assert.ok(data.startsWith(directory)); assert.ok(socket.startsWith(directory));
        assert.equal(await pg.isRunning(), true);
        const client = new Client(pg.admin());
        await client.connect();
        try { assert.equal((await client.query("SHOW listen_addresses")).rows[0]?.listen_addresses, ""); }
        finally { await client.end(); }
      }, { pgBin: bin!, port: 56179, allowedPorts: [56179], withoutQueue: true });
      assert.ok(data && socket);
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(data), false); assert.equal(existsSync(socket), false);
    } finally {
      for (const [index, key] of ["ATTACK_KIT_RUN_ROOT", "ATTACK_KIT_SOCKET_ROOT"].entries()) {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("shell options and libpq targets preserve path bytes without command expansion", () => {
  for (const value of ["plain", "space dir", "quote' dir", 'double" dir', 'comma,back\\ dir',
    ' /tmp/$UNSET/$(printf expanded)/`printf expanded`/line\nend ']) {
    const args = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${pgSocketOptionV1(value)}`],
      { encoding: "utf8", timeout: 120_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" } }).split("\0");
    assert.deepEqual(args, ["-c", `unix_socket_directories="${value.replaceAll('"', '""')}"`, ""]);
    assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${shellArgumentV1(value)}`],
      { encoding: "utf8", timeout: 120_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" } }), value);
    assert.deepEqual(parseKeywordValueTarget(`host=${pgConninfoValueV1(value)} port=56179 dbname=fixture`),
      { host: value, port: 56179, database: "fixture" });
  }
});

test("pg_ctl start carries data paths in PGDATA and leaves stop/status explicit", () => {
  const environment = { NODE_ENV: "test" as const, LC_ALL: "C" };
  const data = '/tmp/space \'and"quote';
  assert.deepEqual(pgCtlInvocationV1(["-D", data, "-o", "-p 56179", "start"], environment),
    { args: ["-o", `-p 56179 -D ${shellArgumentV1(data)}`, "start"], environment: { ...environment, PGDATA: data } });
  for (const verb of ["stop", "status"]) {
    const args = ["-D", data, verb];
    assert.deepEqual(pgCtlInvocationV1(args, environment), { args, environment });
  }
  assert.deepEqual(environment, { NODE_ENV: "test", LC_ALL: "C" });
});

test("real pg_ctl forwards quoted socket options and PGDATA without shared memory", { skip: !bin }, async () => {
  const root = await mkdtemp("/tmp/pg-argv-");
  try {
    const fake = join(root, "postgres ' \"stand-in");
    await writeFile(fake, `#!/bin/sh
case " $* " in *" -C "*) printf '%s\\n' "$PGDATA" ;; *) printf '%s\\0' "$@" > "$PGDATA/received-argv" ;; esac
`, { mode: 0o700 });
    for (const suffix of ["space dir", "quote' dir", 'double" dir', 'comma,back\\ dir']) {
      const data = join(root, suffix);
      await mkdir(data);
      await writeFile(join(data, "PG_VERSION"), "17\n");
      const invocation = pgCtlInvocationV1(["-D", data, "-p", fake, "-l", join(data, "log"),
        "-w", "-t", "1", "-o", pgSocketOptionV1(data), "start"],
        { NODE_ENV: "test" as const, PATH: "/usr/bin:/bin", LC_ALL: "C" });
      // The stand-in exits without creating a postmaster; pg_ctl must finish waiting.
      assert.throws(() => execFileSync(join(bin!, "pg_ctl"), invocation.args,
        { env: invocation.environment, timeout: 10_000, stdio: "pipe" }));
      const { readFile } = await import("node:fs/promises");
      assert.deepEqual((await readFile(join(data, "received-argv"), "utf8")).split("\0"),
        ["-c", `unix_socket_directories="${data.replaceAll('"', '""')}"`, "-D", data, ""]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

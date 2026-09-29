import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { concurrently, realPostgresSkipMessage, requiresRealPostgres, withRealPostgres,
  type RealPostgres } from "./support/attack-kit/index";

const PORT = 56169;
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => {
  if (PG) { required += 1; return undefined; }
  return { skip: realPostgresSkipMessage() };
};
const digest = `sha256:${"a".repeat(64)}`;
const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();

type LeaseSeed = Readonly<{
  id: string;
  path?: string;
  kind?: "file" | "tree";
  project?: "alpha" | "beta";
  declared?: boolean;
  state?: "active" | "revoked";
  acquiredAt?: string;
  expiresAt?: string;
}>;

async function seedBase(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:lease-attack','Lease attack tenant')");
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:lease-attack','tenant:lease-attack','Lease attacks')");
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:lease-attack','tenant:lease-attack','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);
  for (const project of ["alpha", "beta"] as const) {
    await admin.query(`INSERT INTO projects
      (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
       health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,'tenant:lease-attack','workspace:lease-attack','adapter:lease-attack',$1,'1',$1,'running','fixture',
       'healthy','control_room_native',now(),'{}',now())`, [`project:${project}`]);
    await admin.query(`INSERT INTO control_requests
      (id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
      VALUES($1,'tenant:lease-attack',$2,'accepted',0,$1,'{}',now(),now())`,
    [`request:${project}`, `project:${project}`]);
    await admin.query(`INSERT INTO control_workflows
      (id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
      VALUES($1,'tenant:lease-attack',$2,$3,$4,'active',0,'{}',now(),now())`,
    [`workflow:${project}`, `request:${project}`, `project:${project}`, digest]);
  }
  await admin.query(`INSERT INTO control_nodes
    (id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES('node:lease-attack','tenant:lease-attack','active',0,'key:lease-attack','{}',now(),now())`);
}

async function seedLease(admin: Client, seed: LeaseSeed) {
  const project = seed.project ?? "alpha", kind = seed.kind ?? "tree", path = seed.path ?? "src/shared";
  const acquiredAt = seed.acquiredAt ?? iso(-1_000), expiresAt = seed.expiresAt ?? iso(120_000);
  await admin.query(`INSERT INTO control_jobs
    (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,'tenant:lease-attack',$2,$3,'leased',0,50,'fixture',$4,'{}',$5,$5)`,
  [`job:${seed.id}`, `workflow:${project}`, `project:${project}`, digest, acquiredAt]);
  await admin.query(`INSERT INTO control_attempts
    (id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,'tenant:lease-attack',$2,1,'leased',0,'worker:lease-attack','node:lease-attack',1,'{}',$3,$3)`,
  [`attempt:${seed.id}`, `job:${seed.id}`, acquiredAt]);
  await admin.query(`INSERT INTO control_leases
    (id,tenant_id,job_id,attempt_id,node_id,epoch,state,version,acquired_at,expires_at,payload,created_at,updated_at)
    VALUES($1,'tenant:lease-attack',$2,$3,'node:lease-attack',1,$4,0,$5,$6,'{}',$5,$5)`,
  [`lease:${seed.id}`, `job:${seed.id}`, `attempt:${seed.id}`, seed.state ?? "active", acquiredAt, expiresAt]);
  if (seed.declared !== false) await admin.query(`INSERT INTO control_task_declared_scopes
    (tenant_id,project_id,job_id,scope_kind,path,path_fold)
    VALUES('tenant:lease-attack',$1,$2,$3,$4,$4)`,
  [`project:${project}`, `job:${seed.id}`, kind, path]);
}

const scopeInsert = (seed: LeaseSeed, override: Partial<LeaseSeed> = {}) => {
  const value = { ...seed, ...override }, project = value.project ?? "alpha";
  const kind = value.kind ?? "tree", path = value.path ?? "src/shared";
  return {
    sql: `INSERT INTO control_assignment_lease_scopes
      (tenant_id,lease_id,project_id,job_id,attempt_id,node_id,scope_kind,path,path_fold)
      VALUES('tenant:lease-attack',$1,$2,$3,$4,'node:lease-attack',$5,$6,$6)`,
    params: [`lease:${value.id}`, `project:${project}`, `job:${value.id}`, `attempt:${value.id}`, kind, path],
  };
};

async function insertAsCoordinator(postgres: RealPostgres, seed: LeaseSeed, override: Partial<LeaseSeed> = {}) {
  const statement = scopeInsert(seed, override);
  return postgres.query("coordinator", statement.sql, statement.params);
}

const errorCode = (error: unknown) => (error as { code?: string }).code;

test("ownership lease trigger resists clock, overlap, state, declaration, temp-shadow, and underscore attacks",
  needsPg(), async () => {
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin());
      await admin.connect();
      try {
        await seedBase(admin);

        const catalog = (await admin.query<{ proconfig: string[]; definition: string }>(`SELECT proconfig,
          pg_get_functiondef('enforce_assignment_lease_scope_collision()'::regprocedure) AS definition
          FROM pg_proc WHERE oid='enforce_assignment_lease_scope_collision()'::regprocedure`)).rows[0]!;
        assert.deepEqual(catalog.proconfig, ["search_path=pg_catalog, public, pg_temp"]);
        assert.match(catalog.definition, /lease\.expires_at\s*>\s*lease\.acquired_at/i,
          "a far-future injected application clock does not make the trigger use an unrelated wall clock for its own lease");
        assert.match(catalog.definition, /lease\.expires_at\s*>\s*LEAST\(clock_timestamp\(\), acquisition_time\)/i,
          "held-lease liveness uses the same acquisition time as the application, with the wall clock as a fail-closed floor");

        const future = { id: "future-clock", path: "future/clock", acquiredAt: "2126-01-15T08:00:00.000Z",
          expiresAt: "2126-01-15T08:01:00.000Z" } as const;
        await seedLease(admin, future);
        await insertAsCoordinator(postgres, future);

        const nested = [
          { id: "nested-0", path: "src/tree" },
          { id: "nested-1", path: "src/tree/a" },
          { id: "nested-2", path: "src/tree/a/b" },
          { id: "nested-3", path: "src/tree/a/b/c" },
        ] as const;
        for (const lease of nested) await seedLease(admin, lease);
        const clients = await Promise.all(nested.map(async () => {
          const client = new Client(postgres.connection("coordinator")); await client.connect(); return client;
        }));
        try {
          const outcomes = await concurrently(clients.length, async index => {
            const statement = scopeInsert(nested[index]!);
            try { await clients[index]!.query(statement.sql, statement.params); return "winner"; }
            catch (error) { assert.equal(errorCode(error), "23P01"); return "refused"; }
          }, { boundMs: 10_000 });
          assert.equal(outcomes.filter(value => value === "winner").length, 1,
            "pairwise nested scopes have exactly one database winner");
        } finally { await Promise.all(clients.map(client => client.end())); }

        const expiredHeld = { id: "expired-held", path: "state/expired", acquiredAt: iso(-120_000), expiresAt: iso(60_000) };
        const expiredNext = { id: "expired-next", path: "state/expired" };
        await seedLease(admin, expiredHeld); await seedLease(admin, expiredNext);
        await insertAsCoordinator(postgres, expiredHeld);
        await admin.query("UPDATE control_leases SET expires_at=$1 WHERE tenant_id='tenant:lease-attack' AND id=$2",
          [iso(-60_000), `lease:${expiredHeld.id}`]);
        await insertAsCoordinator(postgres, expiredNext);

        const revokedHeld = { id: "revoked-held", path: "state/revoked" };
        const revokedNext = { id: "revoked-next", path: "state/revoked" };
        await seedLease(admin, revokedHeld); await seedLease(admin, revokedNext);
        await insertAsCoordinator(postgres, revokedHeld);
        await admin.query("UPDATE control_leases SET state='revoked' WHERE tenant_id='tenant:lease-attack' AND id=$1",
          [`lease:${revokedHeld.id}`]);
        await insertAsCoordinator(postgres, revokedNext);

        const undeclared = { id: "undeclared", path: "undeclared/path", declared: false } as const;
        await seedLease(admin, undeclared);
        await assert.rejects(insertAsCoordinator(postgres, undeclared), error => errorCode(error) === "23514");
        const widened = { id: "widened", kind: "file", path: "docs/one.md" } as const;
        await seedLease(admin, widened);
        await assert.rejects(insertAsCoordinator(postgres, widened, { kind: "tree", path: "" }),
          error => errorCode(error) === "23514");
        const wrongProject = { id: "wrong-project", path: "project/path" } as const;
        await seedLease(admin, wrongProject);
        await assert.rejects(insertAsCoordinator(postgres, wrongProject, { project: "beta" }),
          error => errorCode(error) === "23514");
        const inactive = { id: "inactive-own", path: "inactive/path", state: "revoked" } as const;
        await seedLease(admin, inactive);
        await assert.rejects(insertAsCoordinator(postgres, inactive), error => errorCode(error) === "23514");

        const underscoreA = { id: "underscore-a", path: "a_b" } as const;
        const underscoreB = { id: "underscore-b", path: "axb/c" } as const;
        await seedLease(admin, underscoreA); await seedLease(admin, underscoreB);
        await insertAsCoordinator(postgres, underscoreA);
        await insertAsCoordinator(postgres, underscoreB);

        const shadowHeld = { id: "shadow-held", path: "shadow/shared" } as const;
        const shadowNext = { id: "shadow-next", path: "shadow/shared" } as const;
        await seedLease(admin, shadowHeld); await seedLease(admin, shadowNext);
        await insertAsCoordinator(postgres, shadowHeld);
        await admin.query(`GRANT TEMPORARY ON DATABASE "${postgres.database}" TO control_room_coordinator`);
        const attacker = new Client(postgres.connection("coordinator"));
        await attacker.connect();
        try {
          await attacker.query("CREATE TEMP TABLE control_leases (LIKE public.control_leases INCLUDING ALL)");
          await attacker.query("INSERT INTO control_leases SELECT * FROM public.control_leases WHERE tenant_id=$1 AND id=$2",
            ["tenant:lease-attack", `lease:${shadowNext.id}`]);
          const statement = scopeInsert(shadowNext);
          await assert.rejects(attacker.query(statement.sql, statement.params), error => errorCode(error) === "23P01",
            "a pg_temp relation cannot shadow the public collision set");
        } finally { await attacker.end(); }
      } finally { await admin.end(); }
    }, { port: PORT, allowedPorts: [PORT], database: "control_room", boundMs: 120_000 });
  });

test("the ownership-lease real-PostgreSQL attack ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1);
  assert.equal(ran, required);
});

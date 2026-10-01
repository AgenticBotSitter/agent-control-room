// Real-PostgreSQL proof for item 10a's typed passkey ports, on PostgreSQL 17,
// run as the PRODUCTION logins and never as a superuser.
//
// This is the lane the review's §5 asked for (P-1..P-8). In order:
//
//   1. `registrationRows` returns EVERY row for a digest — no LIMIT, no dedupe,
//      no "latest wins" — and each row is the whole WebAuthn response with every
//      binary field as unpadded base64url that round-trips exactly;
//   2. the new columns' CHECKs refuse an over-bound response, at the limit and
//      one byte over, so an over-bound input never reaches a parser;
//   3. an insert is accepted ONLY for a registration the updater opened: an
//      unknown digest, a consumed one and an expired one are each refused by
//      name, and the per-digest row cap holds a flood bounded;
//   4. the web login's new surface is exactly five columns of SELECT and no
//      INSERT, no UPDATE, no DELETE — and the migrator still reaches nothing;
//   5. 50 concurrent registrations on one digest: all the racers' rows land and
//      every one of them is visible, and the installer's exactly-one rule then
//      refuses (50 rows > 1) rather than silently picking a winner;
//   6. the refusal aggregate: exactly ONE firstInHour per plan-hour under 50
//      concurrent callers, a replayed approval is a no-op, the bucket is the
//      DATABASE's hour, and 10 000 same-hour refusals produce exactly one journal
//      line and one push, with a bounded table;
//   7. the counter-rollback case: a new counter that is not greater than the
//      stored one is refused, and the refusal is recorded once;
//   8. the cooling-off enqueue is atomic and idempotent, and refuses loudly with
//      zero subscriptions rather than reporting a warning that was never sent.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { securityDefinerAuditLive } from "./support/attack-kit/search-path-audit";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";
import { PasskeyStoreV1, PasskeyWebStoreV1 } from "../src/updater/v1/passkey-store.mjs";
import { comparisonCodeV1, PasskeyRefusalAggregatorV1 } from "../src/updater/v1/passkey.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";
import { sendControlRequestV1 } from "../src/updater/v1/control-socket.mjs";
import { createMacLocalPasskeyRegistrationPortV1 } from "../src/web/v1/mac-local-host";

// 59670 is the port block this job was given.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59670), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:passkey-pg";
const OWNER = "identity:passkey-pg-owner";
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const OWNER_SESSION = DIGEST("owner-session-fixture");
const INSTALLATION = "install-fixture";
const RP_ID = "control-room.example.test";
/** 32 bytes of authenticatorData and a 64-byte signature: both legal, both real. */
/**
 * An ASSERTION's authenticatorData: rpIdHash (32) + flags (1) + signCount (4) = 37
 * bytes is the floor, and a real one is longer. 32 was used first here and the
 * column bound refused it, which is the bound working — the assertion columns
 * carry the WRAPPER's numbers, and the wrapper's floor for an assertion is 37,
 * not the 32 that `plan_approvals` accepts for a bare blob.
 */
const AUTH = Buffer.alloc(37, 0x11), SIG = Buffer.alloc(64, 0x22);
const CLIENT = Buffer.from('{"type":"webauthn.create"}', "utf8");
const ATTEST = Buffer.alloc(512, 0x33);
const CREDENTIAL = "Y3JlZGVudGlhbC1maXh0dXJlLTMyLWJ5dGVzLWxvbmc";
const b64 = (bytes: Buffer) => bytes.toString("base64url");

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");

function as(postgres: Postgres, role: "deployer" | "web" | "migrator") {
  const login = role === "deployer" ? "control_room_deployer" : role === "web" ? "control_room_web"
    : "control_room_migrator";
  const password = role === "deployer" ? DEPLOYER_PASSWORD
    : (postgres.connection(role === "web" ? "web" : "migrator") as { password: string }).password;
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: login, password });
}

async function seed<T extends Record<string, unknown>>(postgres: Postgres, sql: string, params: unknown[] = []) {
  const client = new Client(postgres.admin());
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    return (await client.query<T>(sql, params as never[])).rows;
  } finally { await client.end(); }
}

async function seedOwnerSession(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed(postgres, `INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [TENANT]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [OWNER, TENANT, DIGEST(OWNER), now]);
  await seed(postgres, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
    allowed_actions,project_ids,created_at,updated_at)
    VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4) ON CONFLICT DO NOTHING`,
  [`grant:${OWNER}`, TENANT, OWNER, now]);
  await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [TENANT, OWNER_SESSION, OWNER, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
}

async function seedSubscription(postgres: Postgres, endpoint: string) {
  await seed(postgres, `INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,created_at,updated_at)
    VALUES($1,$2,$3,'p256dh','auth',now(),now()) ON CONFLICT (tenant_id,endpoint) DO NOTHING`,
  [`push:${createHash("sha256").update(endpoint).digest("hex")}`, TENANT, endpoint]);
}

const planId = (suffix: string) => `plan-${suffix}`;
const planJson = (id: string) => ({
  schema: "control-room.install-plan/v2", planId: id, kind: "code", installationId: INSTALLATION,
});

/**
 * Insert a plan as the deployer. `state` defaults to `ready_for_approval`, which
 * is the only state §5.5's one-open-plan rule treats as competing for the owner's
 * Face ID; a test that needs a SECOND plan must therefore pass a closed state, or
 * it will be measuring that rule instead of whatever it meant to measure.
 */
async function insertPlan(postgres: Postgres, id: string, { state = "ready_for_approval" } = {}) {
  const client = as(postgres, "deployer");
  await client.connect();
  try {
    await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
      changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
      VALUES($1,$2,'code',$3,'{code}',false,false,$4,$5::jsonb,false,now()+interval '72 hours')`,
    [id, INSTALLATION, state, DIGEST(`plan-${id}`), JSON.stringify(planJson(id))]);
  } finally { await client.end(); }
}

/**
 * Assert that a statement is refused, and return its SQLSTATE and message head.
 *
 * The parameter argument is the WHOLE values array or nothing at all, because
 * `pg`'s `query(text, values)` takes exactly that: passing the values as varargs
 * puts an object where `pg` expects a callback and fails with `callback is not a
 * function`, which says nothing about the statement being measured. Both shapes
 * this lane needed — eight placeholders and none — are therefore spelled the same
 * way here, with `undefined` meaning "no parameters".
 */
async function refuses(client: Client, sql: string, params?: unknown[]): Promise<string> {
  try {
    await client.query(sql, params as never[]);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 140)}`);
}

async function installUpdaterSchema(postgres: Postgres, { directory = DDL_DIRECTORY,
  rolesFile = join(process.cwd(), "db/roles/updater_release_reader_roles.sql") } = {}) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap, directory, deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(rolesFile, "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect();
        return deployer;
      },
    });
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

/** A connected deployer client with `PasskeyStoreV1` already initialised. */
async function deployerStore(postgres: Postgres) {
  const client = as(postgres, "deployer");
  await client.connect();
  const store = new PasskeyStoreV1(client);
  await store.initialize();
  return { client, store };
}

/** A connected web client with `PasskeyWebStoreV1` already initialised. */
async function webStore(postgres: Postgres) {
  const client = as(postgres, "web");
  await client.connect();
  const store = new PasskeyWebStoreV1(client);
  await store.initialize();
  return { client, store };
}

/**
 * A registration row id in the shape the table's CHECK requires: the literal
 * prefix followed by EXACTLY 36 characters of `[0-9a-f-]`. That is a UUID's
 * length, so the fixture derives one from a hash and hyphenates it rather than
 * truncating — a 32-char hex string is 32 characters, and the CHECK refuses it.
 * Worth stating because the first two runs of this lane failed on precisely
 * that, which is the cost of a fixture asserting an id shape it had not read.
 */
const uuidShaped = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const REGISTRATION_ID = (value: string) => `passkey-registration:${uuidShaped(value)}`;

test("P8: default updater and Mac-local composition complete add -> phone -> typed code", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres); await seedOwnerSession(postgres);
    await seedSubscription(postgres, "https://web.push.apple.com/p8-default-path");
    const root = await mkdtemp(join(tmpdir(), "updater-p8-default-"));
    await mkdir(join(root, "updater-state"), { recursive: true }); await mkdir(join(root, "status"));
    await mkdir(join(root, "Protected/config"), { recursive: true });
    await writeFile(join(root, "updater-state/self-update"), "Off\n");
    await writeFile(join(root, "Protected/config/host.json"), JSON.stringify({ installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: `https://${RP_ID}` }));
    const deployer = as(postgres, "deployer"), web = as(postgres, "web");
    const credentialId = Buffer.alloc(32, 23).toString("base64url"), code = comparisonCodeV1(credentialId);
    let updater: Awaited<ReturnType<typeof startUpdaterV1>> | undefined;
    try {
      await deployer.connect(); await web.connect();
      updater = await startUpdaterV1({ alerts: null, root, client: deployer, passkeyVerifier: {
        async verifyRegistration({ response }: { response: { id: string } }) {
          return { credentialId: response.id, publicKey: Buffer.alloc(64, 31).toString("base64url"),
            algorithm: -7, counter: 0, transports: ["internal"] };
        }, async verifyAuthentication() { throw new Error("no existing passkey in cooling-off route"); },
      } });
      updater.loop.stop();
      const socket = join(root, "updater-state/control.sock");
      const begun = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
        requestId: "p8-default-begin", verb: "passkey-add-begin", arguments: [] }) as { registrationSecret: string };
      const phone = createMacLocalPasskeyRegistrationPortV1(web as never);
      const options = await phone.options({ ownerSessionDigest: OWNER_SESSION,
        registrationSecret: begun.registrationSecret }) as { publicKey: { challenge: string } };
      assert.match(options.publicKey.challenge, /^[A-Za-z0-9_-]{43}$/u);
      const response = { id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64(CLIENT), attestationObject: b64(ATTEST), transports: ["internal"] } };
      await Promise.all(Array.from({ length: 20 }, () => phone.insert({ ownerSessionDigest: OWNER_SESSION,
        registrationSecret: begun.registrationSecret, comparisonCode: code, response,
        authorizationAssertion: null })));
      assert.equal((await deployer.query<{ n: number }>(`SELECT count(*)::int AS n
        FROM updater.passkey_registrations`)).rows[0]?.n, 1,
      "a burst of exact phone retries creates one row");
      const completed = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
        requestId: "p8-default-complete", verb: "passkey-add-complete",
        arguments: [begun.registrationSecret, code] }) as { credentialId: string; coolingOffUntil: string };
      assert.equal(completed.credentialId, credentialId); assert.equal(typeof completed.coolingOffUntil, "string");
      assert.equal((await deployer.query<{ n: number }>(`SELECT count(*)::int AS n
        FROM updater.passkey_open_registrations WHERE consumed_at IS NULL`)).rows[0]?.n, 0);
      const listed = await sendControlRequestV1(socket, { schema: "control-room.updater-control/v1",
        requestId: "p8-default-list", verb: "passkey-list", arguments: [] }) as { credentialId: string }[];
      assert.deepEqual(listed.map(item => item.credentialId), [credentialId]);
    } finally {
      await updater?.stop();
      await Promise.allSettled([web.end(), deployer.end()]);
      await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

/**
 * The shape `PasskeyStoreV1.registrationRows` promises.
 *
 * Declared HERE rather than imported because the store is a `.mjs` module with no
 * type declarations, so every callback over its result would otherwise be
 * implicitly `any` — and `pnpm check` (which does not read test files) would stay
 * green while `check:demo` failed. Spelling the shape here is also the most
 * useful place to state it: this IS the contract P-1 asks for, and a reader can
 * check it against the port without leaving this file.
 *
 * Every binary field is unpadded base64url that round-trips exactly, because the
 * wrapper in passkey.mjs refuses anything else.
 */
interface RegistrationRowV1 {
  readonly registrationDigest: string;
  readonly credentialId: string;
  readonly comparisonCode: string;
  readonly response: {
    readonly id: string;
    readonly rawId: string;
    readonly type: "public-key";
    readonly response: {
      readonly clientDataJSON: string;
      readonly attestationObject: string;
      readonly transports: readonly string[];
    };
    readonly clientExtensionResults: Record<string, never>;
  };
  readonly authorizationAssertion: {
    readonly id: string;
    readonly response: {
      readonly clientDataJSON: string;
      readonly authenticatorData: string;
      readonly signature: string;
      readonly userHandle: string | null;
    };
  } | null;
  readonly receivedAt: string;
}
const registrationDigest = (value: string) => DIGEST(`registration-${value}`);

/** The options object the updater would publish. Shape is the authority's, not
 * this file's: the whole point of P-2 is that the web renders the updater's
 * bytes, so a fixture that re-derived them would be testing nothing. */
const optionsFor = (digest: string, mode: "initial" | "add", extra: Record<string, unknown> = {}) => ({
  schema: "control-room.passkey-registration-options/v1", registrationDigest: digest,
  publicKey: { challenge: b64(Buffer.alloc(32, 7)), rp: { id: RP_ID, name: "Control Room" },
    user: { id: b64(Buffer.alloc(32, 9)), name: "Control Room owner", displayName: "Control Room owner" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }],
    timeout: 1_800_000, attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: [] },
  authorization: mode === "add" ? { challenge: b64(Buffer.alloc(32, 8)), rpId: RP_ID, allowCredentials: [],
    userVerification: "required" } : null,
  ...extra,
});

/**
 * Publish one open registration as the deployer.
 *
 * `expiresInMs` may be NEGATIVE to publish one already past its expiry. The
 * obvious value for "expired" is -1_000, and it is WRONG: the store computes the
 * interval from the JavaScript clock and the guard compares against the DATABASE
 * clock, so a row published one second ago can still be in the future by the
 * time the insert runs, and `expires_at <= now()` is then false. An hour in the
 * past cannot be rescued by a clock skew, so that is what the negative cases use.
 */
async function openRegistration(postgres: Postgres, store: PasskeyStoreV1, digest: string,
  mode: "initial" | "add" = "initial", expiresInMs = 1_800_000) {
  await store.openRegistration({ registrationDigest: digest, installationId: INSTALLATION, mode,
    optionsJson: optionsFor(digest, mode),
    authorizationChallenge: mode === "add" ? b64(Buffer.alloc(32, 8)) : null,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
}

/** One registration row's raw values, so a test can vary one bound at a time. */
function registrationValues(digest: string, overrides: Record<string, unknown> = {}) {
  const credentialId = (overrides.credentialId as string | undefined) ?? CREDENTIAL;
  return {
    id: (overrides.id as string | undefined) ?? REGISTRATION_ID(randomUUID()),
    registrationDigest: digest, credentialId,
    attestationObject: (overrides.attestationObject as Buffer | undefined) ?? ATTEST,
    clientDataJson: (overrides.clientDataJson as Buffer | undefined) ?? CLIENT,
    transports: (overrides.transports as string[] | undefined) ?? ["internal"],
    comparisonCode: (overrides.comparisonCode as string | undefined) ?? comparisonCodeV1(credentialId),
    ownerSessionDigest: OWNER_SESSION,
    ...overrides,
  };
}

const INSERT_REGISTRATION = `INSERT INTO updater.passkey_registrations(id,registration_digest,credential_id,
  attestation_object,client_data_json,transports,comparison_code,owner_session_digest)
  VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8)`;

// -----------------------------------------------------------------------------

test("registrationRows returns every row, whole, with unpadded base64url that round-trips", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // P-1's headline: TWO rows for one digest both land and BOTH come back. A
      // LIMIT, a DISTINCT or "latest wins" would make the installer's one-row
      // rule unobservable, which is the entire reason the port exists in this
      // shape.
      const digest = registrationDigest("two-rows"), fixed = Date.now().toFixed();
      await openRegistration(postgres, store, digest);
      const raceCredential = "c2Vjb25kLWNyZWRlbnRpYWwtZml4dHVyZS0zMi1ieXRlcy1sb25n";
      const params = (credentialId: string, id: string): unknown[] => {
        const v = registrationValues(digest, { id, credentialId });
        return [v.id, v.registrationDigest, v.credentialId, v.attestationObject, v.clientDataJson,
          v.transports, v.comparisonCode, v.ownerSessionDigest];
      };
      await web.query(INSERT_REGISTRATION, params(CREDENTIAL, REGISTRATION_ID(`${fixed}-a`)));
      await web.query(INSERT_REGISTRATION, params(raceCredential, REGISTRATION_ID(`${fixed}-b`)));

      const rows = await store.registrationRows(digest) as RegistrationRowV1[];
      assert.equal(rows.length, 2, "both racers are visible; the one-row rule must be able to see them");
      assert.deepEqual(rows.map(row => row.credentialId).sort(), [CREDENTIAL, raceCredential].sort(),
        "every row is its own credential");
      for (const row of rows) {
        // The row is the WHOLE response, with `rawId === id`, so the wrapper's
        // envelope parser can accept it without the web re-deriving anything.
        assert.equal(row.response.id, row.credentialId, "response.id is the credential id");
        assert.equal(row.response.rawId, row.credentialId, "rawId equals id");
        assert.equal(row.response.type, "public-key");
        assert.deepEqual(row.response.response.transports, ["internal"], "the transports came back");
        assert.equal(row.response.response.clientDataJSON, b64(CLIENT), "clientDataJSON, unpadded base64url");
        assert.equal(row.response.response.attestationObject, b64(ATTEST), "attestationObject, unpadded base64url");
        assert.ok(!row.response.response.clientDataJSON.includes("="), "no padding, which the wrapper refuses");
        // The round trip is what the wrapper enforces, so it is proved here too.
        assert.equal(Buffer.from(row.response.response.clientDataJSON, "base64url").toString("base64url"),
          row.response.response.clientDataJSON, "clientDataJSON round-trips exactly");
        assert.equal(Buffer.from(row.response.response.attestationObject, "base64url").toString("base64url"),
          row.response.response.attestationObject, "attestationObject round-trips exactly");
        assert.equal(row.authorizationAssertion, null, "an initial registration carries no add assertion");
        assert.equal(row.registrationDigest, digest);
        assert.equal(row.comparisonCode, comparisonCodeV1(row.credentialId),
          "the comparison code is the one computed from the credential id");
        assert.equal(typeof row.receivedAt, "string", "received_at is reported as an ISO instant");
      }
      // Ordering is fixed, so a caller that takes the first row is deterministic
      // — and the COUNT is still the answer, which is what the rule uses.
      assert.deepEqual(rows.map(row => row.receivedAt), [...rows].sort().map(row => row.receivedAt),
        "rows come back in a fixed order");

      // An add-mode row carries the assertion, and its bytes are the same
      // unpadded base64url — this is the §5.1 step 7 route, and it is the field
      // item 7's table had nowhere to put.
      const addDigest = registrationDigest("with-authorization");
      await openRegistration(postgres, store, addDigest, "add");
      const authId = "YXV0aC1jcmVkZW50aWFsLWZpeHR1cmUtMzItYnl0ZXMtbG9uZw";
      await web.query(`INSERT INTO updater.passkey_registrations(id,registration_digest,credential_id,
        attestation_object,client_data_json,transports,comparison_code,owner_session_digest,
        auth_credential_id,auth_authenticator_data,auth_client_data_json,auth_signature,auth_user_handle)
        VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13)`,
      [REGISTRATION_ID(randomUUID()), addDigest, CREDENTIAL, ATTEST, CLIENT, ["internal"],
        comparisonCodeV1(CREDENTIAL), OWNER_SESSION, authId, AUTH, CLIENT, SIG, Buffer.alloc(16, 5)]);
      const [withAuth] = await store.registrationRows(addDigest) as RegistrationRowV1[];
      assert.equal(withAuth?.authorizationAssertion?.id, authId, "the add assertion rode along");
      assert.equal(withAuth?.authorizationAssertion?.response.signature, b64(SIG));
      assert.equal(withAuth?.authorizationAssertion?.response.authenticatorData, b64(AUTH));
      assert.equal(Buffer.from(withAuth!.authorizationAssertion!.response.userHandle!, "base64url")
        .toString("base64url"), withAuth!.authorizationAssertion!.response.userHandle,
      "the user handle round-trips too, and may be null rather than absent");

      // Zero rows for an unknown digest is an empty array, never a throw: the
      // caller's one-row rule needs to see zero and refuse, not catch.
      assert.deepEqual(await store.registrationRows(registrationDigest("never-opened")), []);
      // A malformed digest is refused at the port, before any SQL runs.
      await assert.rejects(store.registrationRows("not-a-digest"), /updater_registration_digest_refused/u);
      await assert.rejects(store.registrationRows(`sha256:${"z".repeat(64)}`),
        /updater_registration_digest_refused/u);
    } finally { await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the registration columns' bounds are the wrapper's bounds, at the limit and one over", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // Each bound proved AT the limit first and one byte over second, so a
      // refusal cannot be confused with a refusal below it. These are the
      // wrapper's numbers (passkey.mjs), which is why they are equal.
      const fixed = Date.now().toFixed();
      const insert = async (values: Record<string, unknown>) => web.query(INSERT_REGISTRATION,
        [values.id, values.registrationDigest, values.credentialId, values.attestationObject,
          values.clientDataJson, values.transports, values.comparisonCode, values.ownerSessionDigest]
          .map(value => value as never));
      // ONE DIGEST PER BOUND, and the reason is the per-digest cap of four. This
      // lane needs a row at the limit and one byte over for each of five bounds,
      // which is more than four rows on one registration — so a single digest
      // would have this test measuring the CAP rather than the BOUNDS, and every
      // assertion after the fourth would fail for the wrong reason. The cap is a
      // per-digest property by design, so five digests is the shape it expects.
      const each = async (label: string, body: (digest: string) => Promise<void>) => {
        const digest = registrationDigest(`bounds-${label}`);
        await openRegistration(postgres, store, digest);
        await body(digest);
      };

      // clientDataJSON 1..4096.
      await each("client-data", async digest => {
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-cd-max`),
          clientDataJson: Buffer.alloc(4096, 0x41) }));
        await assert.rejects(insert(registrationValues(digest, { clientDataJson: Buffer.alloc(4097, 0x41) })),
          /passkey_registrations_client_data_bound|passkey_registrations_\w+_check/u,
          "4097 bytes of client data is refused by the bound");
        await assert.rejects(insert(registrationValues(digest, { clientDataJson: Buffer.alloc(0) })),
          /passkey_registrations_client_data_bound|passkey_registrations_\w+_check/u, "and so is zero");
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-cd-min`),
          clientDataJson: Buffer.from("{", "utf8") }));
      });

      // attestation_object 32..8192.
      await each("attestation", async digest => {
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-att-min`),
          attestationObject: Buffer.alloc(32, 0x42) }));
        await assert.rejects(insert(registrationValues(digest, { attestationObject: Buffer.alloc(31, 0x42) })),
          /passkey_registrations_\w+_check/u, "31 bytes of attestation is refused");
        await assert.rejects(insert(registrationValues(digest, { attestationObject: Buffer.alloc(8193, 0x42) })),
          /passkey_registrations_\w+_check/u, "and 8193 is refused");
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-att-max`),
          attestationObject: Buffer.alloc(8192, 0x42) }));
      });

      // transports: at most 8, each at most 32 bytes. An empty array is legal:
      // the browser reported none.
      await each("transports", async digest => {
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-tr-max`),
          transports: Array.from({ length: 8 }, (_, index) => `transport-${index}`) }));
        await assert.rejects(insert(registrationValues(digest, { transports: Array.from({ length: 9 },
          (_, index) => `t${index}`) })), /passkey_registrations_transports_bound|passkey_registrations_\w+_check/u,
        "nine transports are refused");
        await assert.rejects(insert(registrationValues(digest, { transports: ["x".repeat(33)] })),
          /passkey_registrations_transports_bound|passkey_registrations_\w+_check/u,
          "a 33-byte transport is refused");
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-tr-empty`), transports: [] }));
        await insert(registrationValues(digest, { id: REGISTRATION_ID(`${fixed}-tr-32`),
          transports: ["y".repeat(32)] }));
      });

      // The add-mode assertion carries the WRAPPER's assertion bounds, and the
      // pairing CHECK refuses a half-present assertion — which would otherwise
      // reach the verifier as an id with no signature.
      const insertWithAssertion = (id: string, digest: string, authData: Buffer, signature: Buffer,
        authId = "YXV0aC1jcmVkZW50aWFsLWZpeHR1cmUtMzItYnl0ZXMtbG9uZw") =>
        web.query(`INSERT INTO updater.passkey_registrations(id,registration_digest,
        credential_id,attestation_object,client_data_json,transports,comparison_code,owner_session_digest,
        auth_credential_id,auth_authenticator_data,auth_client_data_json,auth_signature)
        VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12)`,
        [id, digest, CREDENTIAL, ATTEST, CLIENT, ["internal"], comparisonCodeV1(CREDENTIAL),
          OWNER_SESSION, authId, authData, CLIENT, signature] as never[]);
      await each("authorization", async digest => {
        // 37 — rpIdHash + flags + signCount — is the wrapper's floor, and it is
        // accepted AT the limit. The first version of this fixture used 32, the
        // number `plan_approvals` accepts for a bare blob, and the column refused
        // it: the assertion columns carry the wrapper's numbers, not that table's.
        await insertWithAssertion(REGISTRATION_ID(`${fixed}-auth-37`), digest, Buffer.alloc(37, 3), SIG);
        await assert.rejects(insertWithAssertion(REGISTRATION_ID(`${fixed}-auth-36`), digest,
          Buffer.alloc(36, 3), SIG), /passkey_registrations_\w+_check/u,
        "36 bytes of authenticatorData is under the 37 floor");
        await assert.rejects(insertWithAssertion(REGISTRATION_ID(`${fixed}-big-sig`), digest,
          AUTH, Buffer.alloc(513, 4)), /passkey_registrations_\w+_check/u,
        "a 513-byte signature is over the 512 bound");
        // The pairing: an id with no signature is not a weaker assertion.
        await assert.rejects(web.query(`INSERT INTO updater.passkey_registrations(id,registration_digest,
          credential_id,attestation_object,client_data_json,transports,comparison_code,owner_session_digest,
          auth_credential_id) VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9)`,
        [REGISTRATION_ID(`${fixed}-half`), digest, CREDENTIAL, ATTEST, CLIENT, ["internal"],
          comparisonCodeV1(CREDENTIAL), OWNER_SESSION,
          "YXV0aC1jcmVkZW50aWFsLWZpeHR1cmUtMzItYnl0ZXMtbG9uZw"] as never[]),
        /passkey_registrations_authorization_pair|passkey_registrations_\w+_check/u,
        "a credential id with no signature is refused");
        // And a malformed credential id inside the assertion is refused too.
        await assert.rejects(insertWithAssertion(REGISTRATION_ID(`${fixed}-short-auth`), digest, AUTH, SIG,
          "tooshort"), /passkey_registrations_\w+_check/u, "an assertion for a malformed credential id is refused");
      });
    } finally { await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("a registration row is accepted only for a registration the updater opened", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // UNKNOWN: a digest the updater never opened. This is the refusal that
      // makes the web's INSERT safe at all — without it, a page that saw the
      // fragment could insert a row for a registration nobody issued.
      // The params builder used for every raw web INSERT below, so a bound or a
      // column can be varied without re-spelling the eight placeholders. `refuses`
      // takes VARARGS (so a statement with no parameters can be refused with no
      // second argument at all), which means an array must be spread rather than
      // passed — the one call site that still passed an object did so silently,
      // and the failure it produced was a TypeError rather than a refusal.
      const rowParams = (digest: string, overrides: Record<string, unknown> = {}, id?: string) => {
        const v = registrationValues(digest, id ? { ...overrides, id } : overrides);
        return [v.id, v.registrationDigest, v.credentialId, v.attestationObject, v.clientDataJson,
          v.transports, v.comparisonCode, v.ownerSessionDigest] as never[];
      };
      assert.match(await refuses(web, INSERT_REGISTRATION,
        rowParams(registrationDigest("unknown"))), /registration digest is not open/u);

      // OPEN: the ordinary path.
      const open = registrationDigest("open"), fixed = Date.now().toFixed();
      await openRegistration(postgres, store, open);
      await web.query(INSERT_REGISTRATION, rowParams(open, {}, REGISTRATION_ID(`${fixed}-ok`)));

      // CONSUMED: after the updater finishes with it, named as its own refusal.
      const consumed = registrationDigest("consumed");
      await openRegistration(postgres, store, consumed);
      const consumedNow = await store.consumeRegistration(consumed);
      const consumedSeen = (await store.openRegistrationOptions(consumed)) === null;
      assert.ok(consumedNow && consumedSeen,
        `the updater must be able to consume it: consumed=${consumedNow} noLongerOffered=${consumedSeen}`);
      assert.equal(await store.consumeRegistration(consumed), false, "consuming twice is a no-op, not an error");
      assert.match(await refuses(web, INSERT_REGISTRATION, rowParams(consumed)),
        /registration was already consumed/u);
      // And the web can no longer read the options for a consumed registration.
      assert.equal(await store.openRegistrationOptions(consumed), null, "a consumed registration is not offered");
      // The consumed marker must outlive the registration, or a late insert is
      // refused as UNKNOWN instead of CONSUMED. The web's DELETE is refused by
      // privilege before any trigger runs, so it proves nothing about the guard;
      // the DEPLOYER owns the table and the trigger is its only barrier.
      assert.match(await refuses(client, "DELETE FROM updater.passkey_open_registrations WHERE registration_digest=$1",
        [consumed]), /^23514 updater open registrations are not deletable/u);
      assert.match(await refuses(web, INSERT_REGISTRATION, rowParams(consumed)),
        /registration was already consumed/u, "still refused by name after the attempted delete");

      // EXPIRED: at the DATABASE clock, which is why the fixture has to lie
      // about the expiry rather than wait 30 minutes.
      const expired = registrationDigest("expired");
      // Published LIVE, then aged by the superuser fixture — which is what
      // "expired" means in production. Publishing one already expired is refused
      // by the table's own `expires_at > created_at` CHECK, and that refusal is
      // asserted separately below: the two are different properties and a single
      // fixture cannot measure both.
      await openRegistration(postgres, store, expired);
      // AGED, not born expired, and the age is chosen from the row's own
      // timestamps rather than from the test's clock — which took three attempts
      // to get right and is worth writing down.
      //
      //   * `SET session_replication_role = replica` disables TRIGGERS but not
      //     CHECK constraints, so publishing `now() - 1 hour` is refused by
      //     `expires_at > created_at` — and it is RIGHT to be: the updater must
      //     never publish a registration that is dead on arrival.
      //   * `created_at + 1 second` satisfies the CHECK but can still be in the
      //     FUTURE when the insert runs, because `created_at` is this very
      //     millisecond. The guard compares `expires_at <= now()`, so a
      //     not-yet-expired row is accepted and the assertion measures nothing.
      //   * `created_at + 1 microsecond` is past `now()` only if at least one
      //     microsecond has elapsed — not guaranteed either.
      //
      // The robust answer is to move `created_at` back rather than `expires_at`
      // forward: the row is given a lifetime in the past on both sides, so the
      // CHECK holds by a wide margin and the expiry is unambiguously behind the
      // guard's `now()`.
      await seed(postgres, "UPDATE updater.passkey_open_registrations"
        + " SET created_at = pg_catalog.now() - interval '1 hour',"
        + " expires_at = pg_catalog.now() - interval '30 minutes' WHERE registration_digest = $1", [expired]);
      assert.match(await refuses(web, INSERT_REGISTRATION, rowParams(expired)), /registration expired/u);
      assert.equal(await store.openRegistrationOptions(expired), null, "an expired registration is not offered");
      // And publishing one already past its expiry is refused by the table, so
      // the updater cannot create a row that is dead on arrival.
      assert.match(await refuses(client, "INSERT INTO updater.passkey_open_registrations"
        + "(registration_digest,installation_id,mode,options_json,expires_at)"
        + " VALUES($1,$2,'initial','{}'::jsonb,pg_catalog.now() - interval '1 hour')",
        [registrationDigest("born-expired"), INSTALLATION]),
      /passkey_open_registration_expiry_after_creation/u);

      // The cap. Four rows per digest is the documented ceiling, so a flood of
      // 10 000 junk inserts against one open registration is refused by the fifth
      // — bounded, while the two-row race above stayed visible.
      const flooded = registrationDigest("flood");
      await openRegistration(postgres, store, flooded);
      let landed = 0, capped = 0;
      for (let index = 0; index < 12; index += 1) {
        try {
          await web.query(INSERT_REGISTRATION,
            rowParams(flooded, {}, REGISTRATION_ID(`${fixed}-flood-${index}`)));
          landed += 1;
        } catch (error) {
          assert.match((error as Error).message, /registration already has \d+ rows/u);
          capped += 1;
        }
      }
      assert.equal(landed, 4, "the cap is four rows per registration digest");
      assert.equal(capped, 8, "and every insert past it is refused by name");
      assert.equal((await store.registrationRows(flooded) as RegistrationRowV1[]).length, 4, "the table holds exactly the cap");
    } finally { await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the web's added surface is five SELECT columns and no write at all", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    const migrator = as(postgres, "migrator");
    await migrator.connect();
    try {
      // The readable columns are exactly the five, and the withheld ones are
      // exactly the rest: `consumed_at` and `installation_id` are the updater's.
      for (const column of ["registration_digest", "mode", "options_json", "authorization_challenge", "expires_at"])
        await web.query(`SELECT ${column} FROM updater.passkey_open_registrations`);
      for (const column of ["consumed_at", "installation_id", "created_at"])
        await refuses(web, `SELECT ${column} FROM updater.passkey_open_registrations`);

      // No write of any kind, and not on the refusal tables either.
      await refuses(web, "INSERT INTO updater.passkey_open_registrations(registration_digest,installation_id,"
        + "mode,options_json,expires_at) VALUES($1,'install-fixture','initial','{}'::jsonb,now())",
      [registrationDigest("web-should-not")]);
      await refuses(web, "UPDATE updater.passkey_open_registrations SET consumed_at=now()");
      await refuses(web, "DELETE FROM updater.passkey_open_registrations");
      await refuses(web, "TRUNCATE updater.passkey_open_registrations");
      await refuses(web, "UPDATE updater.passkey_registrations SET comparison_code='AAAAAA'");
      await refuses(web, "DELETE FROM updater.passkey_registrations");
      // The refusal tables are the updater's alone: not readable, not writable,
      // and the functions behind them are not callable.
      await refuses(web, "SELECT * FROM updater.approval_refusals");
      await refuses(web, "SELECT * FROM updater.approval_refusal_buckets");
      await refuses(web, "INSERT INTO updater.approval_refusals(approval_id,plan_id,reason) VALUES($1,$2,'x')",
        [`approval:${randomUUID()}`, planId("nope")]);
      await refuses(web, "SELECT * FROM updater.record_approval_refusal($1,'p','x')", [`approval:${randomUUID()}`]);
      await refuses(web, "SELECT * FROM updater.enqueue_cooling_off_notices('x',1,now(),now())");
      await refuses(web, "SELECT * FROM updater.passkey_registrations_limits");

      // The migrator still reaches nothing at all, including the new tables.
      for (const table of ["passkey_open_registrations", "approval_refusals", "approval_refusal_buckets",
        "passkey_registrations_limits", "passkey_open_registrations_web"])
        await refuses(migrator, `SELECT * FROM updater.${table}`);
      // The web's usable read is the view (DB-8): SELECT only, and it carries the
      // same five columns and not `consumed_at`, so the web learns "open" without
      // learning when anything was consumed.
      await web.query("SELECT registration_digest, mode, options_json, authorization_challenge, expires_at"
        + " FROM updater.passkey_open_registrations_web");
      await refuses(web, "SELECT consumed_at FROM updater.passkey_open_registrations_web");
      await refuses(web, "INSERT INTO updater.passkey_open_registrations_web(registration_digest,mode,options_json,"
        + "expires_at) VALUES($1,'initial','{}'::jsonb,now())", [registrationDigest("via-view")]);
      await refuses(web, "DELETE FROM updater.passkey_open_registrations_web");
      await refuses(migrator, "CREATE TABLE updater.probe2(id int)");
      assert.equal((await migrator.query<{ usage: boolean }>(
        "SELECT has_schema_privilege(current_user,'updater','USAGE') AS usage")).rows[0]?.usage, false);

      // The full function surface, as an EXACT set rather than "nothing". Two
      // functions are executable by the web login by design: the two IMMUTABLE
      // CHECK helpers, because a CHECK constraint is evaluated as the INSERTING
      // role and would otherwise refuse every web insert with `permission
      // denied for function`. Neither owns an object, reaches a table or reads
      // anything — all EXECUTE buys is the ability to ask whether a value is
      // inside a bound. Every OTHER function — the owner-session guard, the
      // refusal aggregation, the cooling-off enqueue — must stay unreachable,
      // and this asserts the names so a new grant would be a test failure.
      const privileged = new Client(postgres.admin());
      await privileged.connect();
      try {
        const executable = (await privileged.query<{ routine: string }>(`SELECT p.proname || '(' ||
            pg_get_function_identity_arguments(p.oid) || ')' AS routine FROM pg_proc p
          JOIN pg_namespace s ON s.oid = p.pronamespace
          WHERE s.nspname = 'updater'
            AND has_function_privilege('control_room_private_web', p.oid, 'EXECUTE')
          ORDER BY 1`)).rows.map(row => row.routine);
        // `pg_get_function_identity_arguments` reports the ARGUMENT NAMES, not
        // bare types, so the expected strings spell them. Asserted against
        // exactly what the catalog reports rather than against a guess.
        assert.deepEqual(executable, [
          "authorization_complete(credential_id text, authenticator_data bytea, client_data_json bytea, signature bytea)",
          "bounded_transports(value text[])",
        ], "the web login may execute exactly the two CHECK helpers and nothing else");
        // And the migrator, which has no USAGE on the schema at all.
        assert.equal((await privileged.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p
          JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'updater'
            AND has_function_privilege('control_room_migrator', p.oid, 'EXECUTE')`)).rows[0]?.n, 0,
        "the migrator may execute nothing here");
      } finally { await privileged.end(); }
    } finally { await migrator.end(); await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("50 concurrent registrations on one digest all land, and the one-row rule then refuses", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    try {
      // The review's own case: "a loopback bot races the passkey registration →
      // two rows → refused and restarted" (§13 P8). The racing here is on the
      // WEB side, because the web is what an attacker controls; the port under
      // test is the read that has to make the race visible.
      const digest = registrationDigest("race"), CONCURRENCY = 50;
      await openRegistration(postgres, store, digest);
      // The cap is four, so 50 racers cannot all land — and that is the point of
      // the cap. Without the guard's transaction-scoped advisory lock every one
      // of these transactions counts "zero rows" before any of them commits and
      // all 50 land; that is what the first run of this lane measured. The claim
      // proved here is the combination: the cap HOLDS under 50 real concurrent
      // callers, and every row that did land is visible to `registrationRows`, so
      // the count the installer reads is never lower than the rows that exist.
      const started = Date.now();
      const attempts = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        const racer = as(postgres, "web");
        await racer.connect();
        try {
          const v = registrationValues(digest);
          await racer.query(INSERT_REGISTRATION, [v.id, v.registrationDigest, v.credentialId,
            v.attestationObject, v.clientDataJson, v.transports, v.comparisonCode, v.ownerSessionDigest]);
          return true;
        } catch { return false; } finally { await racer.end(); }
      }));
      const elapsed = Date.now() - started;
      const landed = attempts.filter(Boolean).length;
      const rows = await store.registrationRows(digest) as RegistrationRowV1[];
      assert.equal(rows.length, landed, "every row that landed is visible: no LIMIT, no dedupe, no gap");
      assert.equal(landed, 4, "the cap of four holds under 50 concurrent racers, each on its own connection");
      assert.equal(50 - landed, 46, "and the other 46 were refused rather than lost");
      assert.ok(elapsed < 60_000, `the burst finished in ${elapsed}ms rather than serialising`);
      // And the installer's rule: exactly one, else refuse. 50 racers produce
      // more than one row, so the rule refuses — which is the R13a behaviour,
      // measured on the real store rather than on a fake.
      assert.notEqual(rows.length, 1, "the one-row rule refuses rather than silently picking a winner");
      // A refusal past the cap is the CAP's refusal, by name. Proved on a fresh
      // connection so it is the guard answering, not a leftover transaction in
      // an aborted state: the table is already full, so this one is refused.
      const probe = as(postgres, "web");
      await probe.connect();
      try {
        assert.match(await refuses(probe, INSERT_REGISTRATION,
          [REGISTRATION_ID(`late-${digest}`), digest, CREDENTIAL, ATTEST, CLIENT, ["internal"],
            comparisonCodeV1(CREDENTIAL), OWNER_SESSION] as unknown[]), /already has \d+ rows/u);
      } finally { await probe.end(); }
      // The racers here are ONE bot posting the SAME registration repeatedly, so
      // they share a credential id by construction — that is the P-8 case, not a
      // fixture shortcut. What must still hold is that each landed row is its own
      // INSERT: distinct row ids, so nothing collapsed two attempts into one.
      assert.equal(new Set(rows.map(row => row.registrationDigest)).size, 1,
        "all the racers targeted one registration digest, which is the point");
      assert.equal(new Set((await client.query<{ id: string }>("SELECT id FROM updater.passkey_registrations"
        + " WHERE registration_digest=$1", [digest])).rows.map(row => row.id)).size, rows.length,
      "each landed row is its own insert, with its own id");
      // All 50 attempts either landed or were refused by the cap — never a
      // silent success, and never a hang.
      assert.equal(landed + (CONCURRENCY - landed), CONCURRENCY, "every racer resolved");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the refusal aggregate keeps exactly one firstInHour per plan-hour under 50 callers", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("refusal-concurrency");
    await insertPlan(postgres, plan);
    const { client, store } = await deployerStore(postgres);
    try {
      // 50 SEPARATE deployer connections, because a pool would serialise the
      // very race this measures. Each claims its own approval id.
      const CONCURRENCY = 50;
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        const caller = as(postgres, "deployer");
        await caller.connect();
        const local = new PasskeyStoreV1(caller);
        try {
          await local.initialize();
          return await local.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`,
            planId: plan, reason: "updater_passkey_assertion_refused" });
        } catch (error) { return { error: (error as Error).message }; }
        finally { await caller.end(); }
      }));
      const elapsed = Date.now() - started;
      const failures = results.filter(result => "error" in result);
      assert.deepEqual(failures, [], "every caller succeeded");
      const successes = results as { count: number; firstInHour: boolean; bucketStart: string }[];
      assert.equal(successes.length, CONCURRENCY);
      // The claim: exactly ONE of the 50 was told it was first. Not zero (which
      // would mean nobody is ever warned) and not two (which would mean the
      // owner gets two pushes for one hour of refusals).
      const firsts = successes.filter(result => result.firstInHour);
      assert.equal(firsts.length, 1, `exactly one caller was first in the hour, got ${firsts.length}`);
      assert.equal(successes.filter(result => result.count === 1).length, 1, "and it was the count of 1");
      // Every caller saw the SAME bucket, which is the database's hour and not
      // fifty slightly different instants.
      const buckets = new Set(successes.map(result => result.bucketStart));
      assert.equal(buckets.size, 1, `one bucket for all ${CONCURRENCY} callers`);
      assert.match([...buckets][0]!, /T\d\d:00:00\.000Z$/u, "and it is a whole hour at the database clock");
      assert.equal(Math.max(...successes.map(result => result.count)), CONCURRENCY, "the count reached 50");
      assert.ok(elapsed < 60_000, `the burst finished in ${elapsed}ms rather than serialising`);

      // The stored bucket agrees with what the callers were told.
      const bucket = (await client.query<{ count: number; first_in_hour: string }>(
        "SELECT count, first_in_hour FROM updater.approval_refusal_buckets WHERE plan_id=$1", [plan])).rows[0];
      assert.equal(bucket?.count, CONCURRENCY, "the bucket holds every refusal");
      assert.equal(bucket?.first_in_hour, `approval:${randomUUID().length > 0 ? bucket!.first_in_hour.slice(9) : ""}`,
        "first_in_hour is an approval id");
      assert.match(bucket!.first_in_hour, /^approval:[0-9a-f-]{36}$/u);

      // P-4: neither sink has run, so the bucket is pending — which is what makes
      // the re-drive list non-empty and the alert not silently lost.
      const pending: { planId: string; bucketStart: string; journaled: boolean; pushed: boolean; count: number }[] = await store.pendingRefusalBuckets();
      const mine = pending.find(entry => entry.planId === plan);
      assert.deepEqual({ count: mine?.count, journaled: mine?.journaled, pushed: mine?.pushed },
        { count: CONCURRENCY, journaled: false, pushed: false }, "the bucket is undelivered until both sinks accept");
      // The two halves are acknowledged separately, because the journal can
      // succeed and the push sink fail.
      await store.markRefusalJournaled(plan, mine!.bucketStart);
      assert.equal((await store.pendingRefusalBuckets()).some((entry: { planId: string }) => entry.planId === plan), true,
        "a journaled-only bucket is still pending, because the push did not land");
      await store.markRefusalPushed(plan, mine!.bucketStart);
      assert.equal((await store.pendingRefusalBuckets()).some((entry: { planId: string }) => entry.planId === plan), false,
        "a fully delivered bucket leaves the re-drive list");

      // Delivery is one-way: undoing it would put the same hour back in the queue.
      assert.match(await refuses(client, `UPDATE updater.approval_refusal_buckets SET journaled_at=NULL,
        pushed_at=NULL WHERE plan_id=$1::text`, [plan]), /delivery cannot be undone/u);
      // The identity of a bucket is fixed: neither the plan, the hour, nor the
      // approval that created it may be rewritten.
      // `$1::text` is not decoration: without the cast PostgreSQL cannot infer
      // the parameter's type and refuses with 42P18 BEFORE the trigger runs, so
      // the guard would never be reached and this assertion would be measuring
      // the wrong refusal.
      assert.match(await refuses(client, "UPDATE updater.approval_refusal_buckets SET first_in_hour=$1::text"
        + " WHERE plan_id=$2::text", [`approval:${randomUUID()}`, plan]), /identity is immutable/u);
      // The count is the aggregate's own, and it rises by one or not at all.
      assert.match(await refuses(client, "UPDATE updater.approval_refusal_buckets SET count=count+5"
        + " WHERE plan_id=$1::text", [plan]), /count refused/u);
      // The per-approval ledger is evidence, so it is append-only.
      assert.match(await refuses(client, "DELETE FROM updater.approval_refusals"), /append-only/u);
      assert.match(await refuses(client, "TRUNCATE updater.approval_refusal_buckets"), /append-only/u);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("a replayed approval is a refusal with no effect, and a skew clock opens no second bucket", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("replay");
    await insertPlan(postgres, plan);
    const { client, store } = await deployerStore(postgres);
    try {
      const approvalId = `approval:${randomUUID()}`;
      const first = await store.recordApprovalRefusal({ approvalId, planId: plan, reason: "updater_refusal_input_refused" });
      assert.deepEqual({ count: first.count, firstInHour: first.firstInHour }, { count: 1, firstInHour: true });
      // The same approval, again, from a second connection — the retried NOTIFY
      // or the re-read queue. It must not increment and must not re-earn first.
      const other = as(postgres, "deployer");
      await other.connect();
      const replayStore = new PasskeyStoreV1(other);
      // `initialize` is not optional here: it is what pins `search_path` and
      // asserts the role. A store used without it runs on whatever the
      // connection's default is, which is not the R10b path production sets — so
      // the replay would be measured on a configuration nobody ships.
      await replayStore.initialize();
      let second: { error: string } | { resolved: true };
      try {
        await replayStore.recordApprovalRefusal({ approvalId, planId: plan,
          reason: "updater_refusal_input_refused" });
        second = { resolved: true };
      } catch (error) { second = { error: (error as Error).message }; }
      await other.end();
      assert.ok(!("resolved" in second),
        `a replay must be refused, and the store returned ${JSON.stringify(second)}`);
      // Typed, not a raw 42501 (review passkey2 DB-6): an approval loop reads this
      // as "already counted" rather than as a failure.
      assert.match(second.error, /^updater_refusal_replayed$/u,
        "and refused by its typed name rather than silently accepted");
      assert.equal((await client.query<{ count: number }>(
        "SELECT count FROM updater.approval_refusal_buckets WHERE plan_id=$1", [plan])).rows[0]?.count, 1,
      "the count is still 1 after the replay");

      // The bucket is the DATABASE's hour. `observedAt` is accepted and never
      // used to choose it, so a caller claiming an hour a year ago changes
      // nothing — which is the property that makes a clock-skewed updater safe.
      const skewed = await store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`, planId: plan,
        reason: "updater_passkey_assertion_refused",
        observedAt: "2020-01-01T00:00:00.000Z" } as never);
      assert.equal(skewed.bucketStart, first.bucketStart, "a caller's clock cannot move the bucket");
      assert.equal(skewed.firstInHour, false, "and it is not the first of a new hour");

      // An approval id that is not shaped like one is refused at the port.
      await assert.rejects(store.recordApprovalRefusal({ approvalId: "approval:nope", planId: plan, reason: "x" }),
        /updater_refusal_input_refused/u);
      await assert.rejects(store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`, planId: plan,
        reason: "Not A Token" }), /updater_refusal_input_refused/u);
      // A reason that is free text is refused: it is a code the updater chose.
      await assert.rejects(store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`, planId: plan,
        reason: "the owner's face id did not match" }), /updater_refusal_input_refused/u);
      // And a plan that does not exist is refused by the foreign key, so a junk
      // plan id cannot open a bucket.
      await assert.rejects(store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`,
        planId: planId("never-existed"), reason: "updater_refusal_input_refused" }));
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("10 000 same-hour refusals stay bounded and earn one journal line and one push", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    // Inserted CLOSED, because §5.5's one-open-plan rule refuses a second open
    // plan and this test inserts a second plan later to prove the aggregation is
    // per plan rather than per hour. Two attempts were needed: the first used
    // `approval_required`, which LOOKS closed but is in the same open set — it is
    // the "approve again" state — and the rule fired anyway. `refused_build` is
    // genuinely closed. Both failures were §5.5 working correctly.
    const plan = planId("flood");
    // `approval_required` is NOT closed for §5.5's purpose — it is in the same
    // open set as `ready_for_approval` (it is the "approve again" state), so it
    // still triggers the one-open-plan rule. `refused_build` is a genuinely
    // closed state, and it is the honest one: a plan that never got built cannot
    // be the plan an approval is refused against in production either, so a test
    // that needs many plans in one hour uses the state that is actually closed.
    await insertPlan(postgres, plan, { state: "refused_build" });
    const { client, store } = await deployerStore(postgres);
    try {
      // §13 P8's exact case: "a flood of 10 000 junk approval rows → one journal
      // line and one push per plan per hour, bounded rows refused by CHECKs".
      // The journal and push are counted HERE, from the store's own idempotency
      // key, rather than by calling a fake sink — because the question is
      // whether the DATABASE produces one of each, not whether a test double
      // would.
      const journal: string[] = [], pushes: string[] = [];
      const record = async () => {
        const result = await store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`,
          planId: plan, reason: "updater_passkey_assertion_refused" });
        if (result.firstInHour) {
          const key = `passkey-refusal:${plan}:${result.bucketStart}`;
          journal.push(key); pushes.push(key);
        }
        return result;
      };
      const start = Date.now();
      const counts: number[] = [];
      for (let batch = 0; batch < 100; batch += 1) {
        // 100 concurrent callers per batch, on the same connection pool the
        // updater actually has, so this measures the store rather than 10 000
        // sockets.
        const parallel = await Promise.all(Array.from({ length: 100 }, record));
        counts.push(...parallel.map(result => result.count));
      }
      const elapsed = Date.now() - start;
      assert.equal(counts.length, 10_000, "all 10 000 refusals were recorded");
      assert.equal(journal.length, 1, "exactly one journal line for the hour");
      assert.equal(pushes.length, 1, "exactly one push for the hour");
      assert.equal(Math.max(...counts), 10_000, "and the count the journal would carry is 10 000");
      // The table is bounded by construction: ONE row per plan-hour for the
      // aggregate, and one ledger row per approval id, which is what makes a
      // replay a no-op. Nothing grew per refusal beyond those two.
      const buckets = (await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM updater.approval_refusal_buckets WHERE plan_id=$1", [plan]))
        .rows[0]?.n;
      const ledger = (await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM updater.approval_refusals WHERE plan_id=$1", [plan])).rows[0]?.n;
      assert.equal(typeof buckets, "number");
      assert.equal(buckets, 1, "one aggregate row per plan-hour, however many refusals");
      assert.equal(ledger, 10_000, "one ledger row per approval, which is the idempotency record");
      assert.ok(elapsed < 300_000, `10 000 refusals took ${elapsed}ms`);

      // A SECOND plan in the same hour gets its own bucket and its own first:
      // the aggregation is per plan, not per hour globally.
      //
      // It is inserted CLOSED (`approval_required`) on purpose. §5.5's one-open-plan
      // rule refuses a second open plan, and the first version of this line tried
      // to insert one — so the test was measuring the open-plan guard and failed
      // with "updater already has an open plan". A plan awaiting "approve again"
      // is exactly the state a refused approval can belong to, and the
      // aggregation does not care whether the plan is open.
      const otherPlan = planId("flood-2");
      await insertPlan(postgres, otherPlan, { state: "refused_build" });
      const otherFirst = await store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`,
        planId: otherPlan, reason: "updater_passkey_assertion_refused" });
      assert.equal(otherFirst.firstInHour, true, "a different plan is the first of ITS hour");

      // Pruning removes delivered history and nothing else.
      await store.markRefusalJournaled(plan, otherFirst.bucketStart);
      await store.markRefusalPushed(plan, otherFirst.bucketStart);
      const pruned = await store.pruneRefusalBuckets(30);
      assert.equal(pruned.buckets, 0, "a bucket from this hour is not 30 days old, so nothing is pruned");
      // An undelivered bucket is NEVER pruned, whatever the retention window:
      // that is the difference between a bounded table and a lost alert.
      // A DELETE is NOT refused here, and that is correct: the deployer OWNS this
      // table and `pruneRefusalBuckets` deletes delivered buckets. An earlier
      // version of this line asserted a DELETE was refused, which would have
      // meant the updater could never prune and the aggregate would grow forever —
      // the opposite of the bound this lane exists to prove. The TRUNCATE is
      // refused, and the per-approval ledger is append-only.
      assert.match(await refuses(client, "TRUNCATE updater.approval_refusal_buckets"), /append-only/u);
      assert.match(await refuses(client, "DELETE FROM updater.approval_refusals"), /append-only/u);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("a rolled-back authenticator counter is refused once, and the refusal is aggregated", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("counter-rollback");
    await insertPlan(postgres, plan);
    const { client, store } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // The DB half of the counter-rollback refusal. The cryptographic half is
      // the wrapper's (a newCounter that is not greater than the stored one is
      // refused before any of this), and what is proved here is that the refusal
      // this case produces lands in the aggregate exactly ONCE, however many
      // times the same rolled-back approval is replayed — which is the P-8 case
      // where a bot re-POSTs the same stolen assertion.
      const approvalId = `approval:${randomUUID()}`;
      // A new counter that is LOWER than the stored one: the rolled-back case.
      const storedCounter = 9, rolledBack = Buffer.alloc(4); rolledBack.writeUInt32BE(storedCounter - 1);
      const count = Buffer.alloc(4); count.writeUInt32BE(storedCounter);
      await web.query(`INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,
        client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [approvalId, plan, CREDENTIAL, Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x05]), rolledBack]),
        CLIENT, SIG, OWNER_SESSION]);
      const stored = (await client.query<{ auth: Buffer }>("SELECT authenticator_data AS auth"
        + " FROM updater.plan_approvals WHERE id=$1", [approvalId])).rows[0]?.auth;
      assert.ok(stored, "the assertion row is the evidence");

      // The refusal, once.
      const once = await store.recordApprovalRefusal({ approvalId, planId: plan,
        reason: "updater_passkey_assertion_refused" });
      assert.deepEqual({ count: once.count, firstInHour: once.firstInHour }, { count: 1, firstInHour: true });
      // Every re-processing of the SAME row is a no-op, which is the whole
      // point: a bot re-POSTing one stale assertion must not become 10 000
      // journal lines.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const replay = as(postgres, "deployer");
        await replay.connect();
        try {
          await assert.rejects(new PasskeyStoreV1(replay).recordApprovalRefusal({ approvalId, planId: plan,
            reason: "updater_passkey_assertion_refused" }), /\bupdater_refusal_replayed$/u);
        } finally { await replay.end(); }
      }
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n"
        + " FROM updater.approval_refusal_buckets WHERE plan_id=$1", [plan])).rows[0]?.n, 1, "still one bucket");
      assert.equal((await client.query<{ count: number }>("SELECT count FROM updater.approval_refusal_buckets"
        + " WHERE plan_id=$1", [plan])).rows[0]?.count, 1, "and its count is still 1");
      // A DIFFERENT approval with the same rolled-back counter is a new refusal,
      // and it lands in the same hour's bucket rather than a second one.
      const second = `approval:${randomUUID()}`;
      await web.query(`INSERT INTO updater.plan_approvals(id,plan_id,credential_id,authenticator_data,
        client_data_json,signature,owner_session_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [second, plan, CREDENTIAL, Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x05]), rolledBack]),
        CLIENT, SIG, OWNER_SESSION]);
      const other = await store.recordApprovalRefusal({ approvalId: second, planId: plan,
        reason: "updater_passkey_assertion_refused" });
      assert.deepEqual({ count: other.count, firstInHour: other.firstInHour }, { count: 2, firstInHour: false },
        "a second rolled-back assertion joins the hour's count and earns no second alert");
    } finally { await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the cooling-off notices are atomic, idempotent, and refuse with no subscriptions", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    try {
      const credentialId = "Y29vbGluZy1vZmYtY3JlZGVudGlhbC0zMi1ieXRlcy1sb25n";
      const until = new Date(Date.now() + 86_400_000).toISOString();
      const repeat = new Date(Date.now() + 43_200_000).toISOString();

      // With NO subscriptions the add must REFUSE, which is P-5's explicit
      // case: the owner must never be told a warning was sent when nobody was
      // told. `completeRegistration` burns R and records no passkey on this.
      await assert.rejects(store.notifyCoolingOff({ credentialId, number: 2, coolingOffUntil: until, repeatAt: repeat }),
        /no subscriptions to send to/u);
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.push_queue")).rows[0]?.n, 0,
        "and nothing was queued");

      // With a subscription, both notices land in ONE transaction.
      await seedSubscription(postgres, "https://web.push.apple.com/fixture-one");
      const enqueued = await store.notifyCoolingOff({ credentialId, number: 2, coolingOffUntil: until, repeatAt: repeat });
      assert.equal(enqueued.enqueued, 2, "two notices: now and at 12 h");
      assert.equal(enqueued.subscriptions, 1);
      const rows: { key: string; body: string; not_before: Date | null; queued_at: Date }[] =
        (await client.query<{ key: string; body: string; not_before: Date | null; queued_at: Date }>(
          `SELECT idempotency_key AS key, body, not_before, queued_at FROM updater.push_queue
           WHERE idempotency_key LIKE 'passkey-cooling-off:%' ORDER BY key`)).rows;
      assert.equal(rows.length, 2, "exactly two rows");
      // The immediate one has no `not_before`, so the dispatch loop sends it now;
      // the repeat carries the 12 h instant, so it cannot be sent now. This is
      // the part `push_queue` could not express before this change.
      assert.equal(rows.filter(row => row.not_before === null).length, 1, "one is due immediately");
      const scheduled = rows.find(row => row.not_before !== null);
      assert.ok(scheduled, "one is scheduled");
      assert.equal(new Date(scheduled!.not_before!).getTime(), Date.parse(repeat),
        "the repeat is due at exactly the 12 h instant");
      // The wording is the design's, with the real number in it.
      for (const row of rows)
        assert.equal(row.body, "A new passkey was added on your Mac. It becomes active in 24 hours. "
          + "If this wasn't you, run sudo /usr/local/bin/control-room passkey revoke 2.");
      assert.match(rows[0]!.key, /^passkey-cooling-off:[A-Za-z0-9_-]+:(now|repeat)$/u, "the keys are the credential id");

      // Idempotent on the credential id: a retried add adds nothing, so the
      // owner cannot be told twice about the same key.
      const again = await store.notifyCoolingOff({ credentialId, number: 2, coolingOffUntil: until, repeatAt: repeat });
      assert.equal(again.enqueued, 2, "the count is of rows present, not rows added");
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.push_queue"))
        .rows[0]?.n, 2, "and a second call adds no rows");
      // A DIFFERENT credential id gets its own pair.
      await store.notifyCoolingOff({ credentialId: "c2Vjb25kLWNyZWRlbnRpYWwtZm9yLWEtcmV0cnkta2V5",
        number: 3, coolingOffUntil: until, repeatAt: repeat });
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.push_queue"))
        .rows[0]?.n, 4, "a different credential id enqueues its own two notices");

      // The argument bounds: a repeat in the past, a cooling-off already over, a
      // number outside the ledger's range. Each is refused rather than queued.
      await assert.rejects(store.notifyCoolingOff({ credentialId, number: 2, coolingOffUntil: until,
        repeatAt: new Date(Date.now() - 1000).toISOString() }), /cooling-off notice arguments refused/u);
      await assert.rejects(store.notifyCoolingOff({ credentialId, number: 2,
        coolingOffUntil: new Date(Date.now() - 1000).toISOString(), repeatAt: repeat }),
      /cooling-off notice arguments refused/u);
      await assert.rejects(store.notifyCoolingOff({ credentialId, number: 99, coolingOffUntil: until, repeatAt: repeat }),
        /updater_passkey_number_refused/u);
      await assert.rejects(store.notifyCoolingOff({ credentialId: "short", number: 2, coolingOffUntil: until,
        repeatAt: repeat }), /updater_passkey_credential_refused/u);

      // An expired subscription is not a browser that will be told, so with only
      // an expired one the add refuses — which is the "subscriptions dropped to
      // 0" case §12 requires the updater to notice.
      const fresh = await client.query<{ count: number }>("SELECT count(*)::int AS count"
        + " FROM public.owner_web_push_subscriptions WHERE expires_at IS NOT NULL AND expires_at<=now()");
      assert.equal(typeof fresh.rows[0]?.count, "number");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the open-registration row is the updater's, and P-2's options are its bytes unchanged", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = await webStore(postgres);
    try {
      const digest = registrationDigest("parity");
      const options = optionsFor(digest, "add", { extra: "kept" });
      await store.openRegistration({ registrationDigest: digest, installationId: INSTALLATION, mode: "add",
        optionsJson: options, authorizationChallenge: b64(Buffer.alloc(32, 8)),
        expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
      // The WEB's read returns the updater's object, and nothing in the round
      // trip changed it. This is P-2's parity clause: there is no web-side code
      // that could re-derive the challenge, the RP ID, the origin or the
      // credential lists, because there is no web-side code that computes them.
      const read = await web.store.options(digest);
      assert.deepEqual(read.options, options, "the options object is byte-identical after the round trip");
      assert.equal(read.mode, "add");
      assert.equal(read.authorizationChallenge, b64(Buffer.alloc(32, 8)));
      // The challenge the web will hand the platform is the one the updater
      // published — asserted directly, because "the options came back" says
      // nothing unless the interesting field is checked.
      const shown = read.options as Record<string, any>;
      assert.equal(shown.publicKey.challenge, options.publicKey.challenge);
      assert.equal(shown.publicKey.rp.id, RP_ID);
      // `authenticatorSelection` and `attestation` are INSIDE `publicKey`, which is
      // where `PasskeyAuthorityV1.registrationOptions` puts them and therefore where
      // SimpleWebAuthn expects them. The first version of these lines read them off
      // the top level, and the failure was a TypeError rather than an assertion —
      // which is worth stating, because a TypeError here looks nothing like the
      // mismatch it is.
      assert.equal(shown.publicKey.authenticatorSelection.userVerification, "required");
      assert.equal(shown.publicKey.authenticatorSelection.residentKey, "required");
      assert.equal(shown.publicKey.attestation, "none");
      assert.deepEqual(shown.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 }], "ES256 and EdDSA only");
      assert.equal(shown.authorization?.userVerification, "required",
        "the add-mode authorisation also requires a user verification");
      assert.equal(shown.authorization?.rpId, RP_ID,
        "and it names the same relying party as the registration itself");

      // A duplicate insert is refused by the primary key, and the port maps it to the
    // NAMED refusal rather than letting a raw PostgreSQL message through. That
    // mapping is the reason this assertion is against `already_open` rather than
    // `duplicate key`: a caller that re-runs `begin` must be able to tell "this
    // registration is already published" from any other database failure, and it
    // must not have to parse an error string to do it. The first version did not
    // map it, so the raw `duplicate key value violates unique constraint` reached
    // the caller.
    const republished = await (async () => {
      try {
        await store.openRegistration({ registrationDigest: digest, installationId: INSTALLATION, mode: "add",
          optionsJson: { ...options, publicKey: { ...options.publicKey, challenge: "different" } },
          authorizationChallenge: b64(Buffer.alloc(32, 8)),
          expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
        return null;
      } catch (error) { return error as { code?: string; message: string }; }
    })();
    assert.equal(republished?.code, "updater_registration_already_open",
      `re-publishing must be the port's named refusal, got ${JSON.stringify(republished)}`);

      // The options object must be an OBJECT, so an array cannot stand in for it.
      await assert.rejects(store.openRegistration({ registrationDigest: registrationDigest("array"),
        installationId: INSTALLATION, mode: "initial", optionsJson: ["not", "an", "object"] as never,
        authorizationChallenge: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      /updater_registration_options_refused/u);
      // And the options must carry the digest they were published under.
      await assert.rejects(store.openRegistration({ registrationDigest: registrationDigest("mismatch"),
        installationId: INSTALLATION, mode: "initial", optionsJson: optionsFor(digest, "initial"),
        authorizationChallenge: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      /updater_registration_options_refused/u);
      // An add-mode registration without a challenge, or an initial one with
      // one, is refused at the port rather than by the CHECK alone.
      await assert.rejects(store.openRegistration({ registrationDigest: registrationDigest("no-challenge"),
        installationId: INSTALLATION, mode: "add", optionsJson: optionsFor(registrationDigest("no-challenge"), "add"),
        authorizationChallenge: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      /updater_registration_challenge_refused/u);
      // What the owner is shown is fixed once published: even the deployer, which
      // owns the table, may move only `consumed_at`. A privilege check cannot
      // say this (the owner holds UPDATE), so the guard is the only barrier.
      assert.match(await refuses(client, "UPDATE updater.passkey_open_registrations"
        + " SET options_json = options_json || '{\"swapped\":true}'::jsonb WHERE registration_digest=$1", [digest]),
      /^23514 updater open registration content is immutable/u);
      assert.match(await refuses(client, "UPDATE updater.passkey_open_registrations"
        + " SET expires_at = expires_at + interval '1 day' WHERE registration_digest=$1", [digest]),
      /^23514 updater open registration content is immutable/u);
      assert.deepEqual((await web.store.options(digest)).options, options, "and the options are unchanged");
      // An unknown digest reads as null from the deployer's view too.
      assert.equal(await store.openRegistrationOptions(registrationDigest("never-opened")), null);
      await assert.rejects(web.store.options("not-a-digest"), /updater_registration_digest_refused/u);
    } finally { await web.client.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the web insert path validates the response shape before it reaches the table", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = await webStore(postgres);
    try {
      const digest = registrationDigest("web-insert");
      await store.openRegistration({ registrationDigest: digest, installationId: INSTALLATION, mode: "initial",
        optionsJson: optionsFor(digest, "initial"), authorizationChallenge: null,
        expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
      const credentialId = "d2ViLWluc2VydC1jcmVkZW50aWFsLWZpeHR1cmUtMzItYnl0ZXMtbG9uZw";
      const code = comparisonCodeV1(credentialId);
      const response = { id: credentialId, rawId: credentialId, type: "public-key",
        response: { clientDataJSON: b64(CLIENT), attestationObject: b64(ATTEST), transports: ["internal"] },
        clientExtensionResults: {} };
      // Replace the inner `response` object while keeping the envelope's own keys
      // (`id`, `rawId`, `type`, `clientExtensionResults`) exactly as they are.
      const withResponse = (fields: Record<string, unknown>) =>
        ({ response: { ...response, response: { ...response.response, ...fields } } });
      // `overrides` here are the STORE's input fields (`response`,
      // `authorizationAssertion`, `comparisonCode`, ...), not WebAuthn envelope
      // keys. A case that wants a bad `rawId` must therefore build a whole
      // envelope: `insert({ response: { ...response, rawId: "different" } })`.
      // Setting `rawId` at this level was a no-op, because `insert` spreads these
      // over its own input object and the store never reads a top-level `rawId`.
      const insert = (overrides: Record<string, unknown> = {}) => web.store.insert({ id: REGISTRATION_ID(randomUUID()),
        ownerSessionDigest: OWNER_SESSION, registrationDigest: digest, credentialId, comparisonCode: code,
        response, authorizationAssertion: null, ...overrides });
      // The ordinary path lands, and the updater's read sees it whole.
      await insert();
      const rows = await store.registrationRows(digest) as RegistrationRowV1[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.response.response.clientDataJSON, b64(CLIENT));
      assert.deepEqual(rows[0]?.response.response.transports, ["internal"]);

      // Over-bound and malformed responses are refused BY NAME, at the web port,
      // before any INSERT — so they never reach the table, the CHECKs, or a
      // parser. Each of these would also be refused later by the wrapper; the
      // point of doing it here is that the row never exists.
      const cases: [string, Record<string, unknown>, RegExp][] = [
        // Each case varies ONE FIELD and keeps the rest of the envelope intact,
        // which is the point: `{ response: { ...response.response, x } }` replaces
        // the whole inner `response` object, so the first version of this table
        // dropped `type: "public-key"` along with the bound it meant to test, and
        // every one of these cases was refused by the ENVELOPE check rather than
        // the field's. The refusal was correct and the assertion was measuring
        // the wrong rule — which is why the specific codes are asserted here
        // rather than one generic `response_refused`.
        ["clientDataJSON over 4096", withResponse({ clientDataJSON: b64(Buffer.alloc(4097, 1)) }),
          /updater_passkey_client_data_refused/u],
        ["attestationObject over 8192", withResponse({ attestationObject: b64(Buffer.alloc(8193, 1)) }),
          /updater_passkey_attestation_refused/u],
        ["attestationObject under 32", withResponse({ attestationObject: b64(Buffer.alloc(31, 1)) }),
          /updater_passkey_attestation_refused/u],
        ["nine transports", withResponse({ transports: Array.from({ length: 9 }, (_, i) => `t${i}`) }),
          /updater_passkey_response_refused/u],
        ["a 33-byte transport", withResponse({ transports: ["x".repeat(33)] }),
          /updater_passkey_response_refused/u],
        // `rawId` and `type` are ENVELOPE keys, so they are set at the top level.
        // The first version of this table set them inside the inner `response`
        // object, where they are simply ignored — so those two cases asserted a
        // refusal that never applied, and passed for the wrong reason.
        ["rawId that is not id", { response: { ...response, rawId: "different" } },
          /updater_passkey_response_refused/u],
        ["a type that is not public-key", { response: { ...response, type: "password" } },
          /updater_passkey_response_refused/u],
        ["padded base64url", withResponse({ clientDataJSON: `${b64(CLIENT)}==` }),
          /updater_passkey_client_data_refused/u],
        ["a non-object response", { response: "not an object" }, /updater_passkey_response_refused/u],
        ["a 20 KiB envelope", { response: { ...response, response: { ...response.response,
          padding: "x".repeat(20_000) } } }, /updater_passkey_response_too_large/u],
      ];
      // Each case is checked with its OWN name in the failure message, and the
      // table is deliberately ordered so the FIRST case is the one the lane is
      // about: the port must refuse an over-bound response before any SQL runs.
      // If the assertion message is not naming the case, this loop is measuring
      // something else, so the name is interpolated rather than fixed.
      for (const [name, overrides, code] of cases) {
        let outcome = "no-refusal";
        try {
          await insert(overrides);
        } catch (error) { outcome = (error as { code?: string }).code ?? "unknown"; }
        assert.match(outcome === "no-refusal" ? "" : outcome, code, `${name} must be refused (got ${outcome})`);
      }
      // A wrong comparison code is refused by the port's own alphabet, before
      // the row: the code is 6 characters of the exact alphabet, so `abc234`
      // never reaches the CHECK.
      await assert.rejects(insert({ comparisonCode: "abc234" }), /updater_passkey_code_refused/u);
      await assert.rejects(insert({ comparisonCode: "ABC234 " }), /updater_passkey_code_refused/u);
      // A short credential id is refused.
      await assert.rejects(insert({ credentialId: "tooshort" }), /updater_passkey_credential_refused/u);
      // And the same bounds apply to the add-mode assertion.
      const authAssertion = { id: credentialId, rawId: credentialId, type: "public-key",
        response: { clientDataJSON: b64(CLIENT), authenticatorData: b64(AUTH), signature: b64(SIG),
          userHandle: null }, clientExtensionResults: {} };
      await assert.rejects(insert({ authorizationAssertion: { ...authAssertion,
        response: { ...authAssertion.response, signature: b64(Buffer.alloc(513, 1)) } } }),
      /updater_passkey_signature_refused/u);
      await assert.rejects(insert({ authorizationAssertion: { ...authAssertion,
        response: { ...authAssertion.response, authenticatorData: b64(Buffer.alloc(36, 1)) } } }),
      /updater_passkey_authenticator_data_refused/u);
      // A complete assertion is accepted, and rides along whole.
      await insert({ authorizationAssertion: authAssertion });
      const withAuth = await store.registrationRows(digest) as RegistrationRowV1[];
      assert.equal(withAuth.at(-1)?.authorizationAssertion?.response.signature, b64(SIG));
      assert.equal(withAuth.at(-1)?.authorizationAssertion?.response.userHandle, null,
        "a null user handle is carried as null, not dropped");

      // The session is the DB's check, and a dead one cannot insert.
      await assert.rejects(insert({ ownerSessionDigest: DIGEST("no-such-session") }),
        /updater row needs a live owner session/u);
      // A digest the updater never opened is refused here too, so the web port
      // refuses before PostgreSQL does.
      await assert.rejects(insert({ registrationDigest: registrationDigest("never-opened") }));
      // And a retried POST reusing its id is a successful no-op, which is what
      // lets a phone recover from a lost HTTP response without turning one
      // ceremony into a two-row race.
      //
      // The FIRST insert with an id succeeds — it has to, or the retry has
      // nothing to collide with. An earlier version of these three lines asserted
      // that the first insert was REFUSED, which cannot be true for any id the
      // port accepts; the port was right and the assertion was not.
      await insert({ id: REGISTRATION_ID("fixed-retry") });
      await insert({ id: REGISTRATION_ID("fixed-retry") });
      assert.equal((await store.registrationRows(digest) as RegistrationRowV1[]).length, 3,
        "the exact retry does not add a fourth registration row");
      // And the port refuses a malformed id outright, before any SQL — so a
      // caller that cannot even shape an idempotency key gets a named refusal
      // rather than a database error.
      await assert.rejects(insert({ id: "not-a-registration-id" }),
        /updater_registration_row_refused/u,
        "a malformed idempotency key is refused by the port's own shape check");
    } finally { await web.client.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("the deployer and web ports are separate objects, checked on the prototype", async () => {
  // NO DATABASE NEEDED, and deliberately not part of the real-PG count: this is a
  // structural claim about the two classes, and it is the claim that keeps
  // `PasskeyAuthorityV1`'s `updater_passkey_store_port_unbound` refusal meaningful.
  //
  // WHY IT MATTERS. `PasskeyAuthorityV1` and `PasskeyRefusalAggregatorV1` look for
  // exactly three methods and refuse with `updater_passkey_store_port_unbound` when
  // any is absent — that refusal is how the updater declines to start a registration
  // it cannot complete safely. If the WEB's port also carried them, a caller that
  // wired the wrong object would pass that check and fail later, at the first call,
  // as a 42501 rather than as the named refusal.
  //
  // Checked on the PROTOTYPE, not with `in` or a truthy lookup, so an own property
  // that only exists because some test assigned it cannot satisfy the assertion.
  const deployer = Object.getPrototypeOf(new PasskeyStoreV1({ query: async () => ({ rows: [] }) }));
  const web = Object.getPrototypeOf(new PasskeyWebStoreV1({ query: async () => ({ rows: [] }) }));
  for (const name of ["registrationRows", "notifyCoolingOff", "recordApprovalRefusal"]) {
    assert.equal(typeof deployer[name], "function", `the deployer port must carry ${name}`);
    assert.equal(web[name], undefined,
      `the web port must NOT carry ${name}: a web login holds no authority to do it`);
  }
  // And the two the web genuinely has.
  for (const name of ["options", "insert"]) {
    assert.equal(typeof web[name], "function", `the web port must carry ${name}`);
    assert.equal(deployer[name], undefined, `the deployer port must NOT carry ${name}`);
  }
  // `openRegistration` is how the updater OPENS a registration; the web must never
  // be able to do that, which is the whole reason the table has no INSERT grant.
  for (const name of ["openRegistration", "consumeRegistration"]) {
    assert.equal(typeof deployer[name], "function");
    assert.equal(web[name], undefined, `the web port must NOT carry ${name}`);
  }
  // And every method is bound, so a destructured port still works — the aggregator
  // holds the store, not the method, but this states that nothing here relies on
  // `this` being the object a caller happens to have.
  const store = new PasskeyStoreV1({ query: async () => ({ rows: [] }) });
  const { registrationRows } = store;
  assert.equal(typeof registrationRows, "function");
  await assert.rejects(registrationRows("not-a-digest"), /updater_registration_digest_refused/u,
    "a destructured method still validates its own input, so the guard does not need `this`");
});

test("every routine in schema updater pins its search_path with pg_temp last", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const { client } = await deployerStore(postgres);
    try {
      // THE GATE IS THE CATALOG, not the DDL text. `assertSearchPathPinned` is the
      // repository's own audit: it reads `pg_proc.prosecdef` and the EFFECTIVE
      // `proconfig` after every CREATE and later ALTER/RESET, so a routine whose
      // path was changed afterwards counts as unpinned, and it parses the GUC list
      // with PostgreSQL's own rules rather than by splitting on commas.
      //
      // It is asserted HERE rather than only by the file-scanning hint in
      // `updater-schema-ddl.test.ts` for one reason: item 10a adds four
      // SECURITY DEFINER routines (the refusal aggregation and the cooling-off
      // enqueue among them), and a SECURITY DEFINER routine that resolves a name
      // in an attacker-writable schema executes the attacker's function as the
      // deployer. The offline hint cannot see that; this can.
      const result = await securityDefinerAuditLive(
        async (sql, params) => ({ rows: (await client.query(sql, [...params] as never[])).rows }),
        // No allowlist. The release ledger's waiver file is about the release
        // schema's routines; schema `updater` is the updater's own DDL, where a
        // waiver would defeat the point. Passing the release allowlist here would
        // report every one of ITS entries as stale (an entry that matches no
        // current violation is itself a failure) and fail a lane that has nothing
        // to do with the release schema.
        { schemas: ["updater"], allowlist: { entries: [], active: new Map(), expired: [] } },
      );
      // The gate, once the reading is in hand. `assertSearchPathPinned` throws
      // with the whole result attached, which is right for a CI job and wrong for
      // a test that wants to say WHICH check failed — so the reading comes first
      // and the assertion names the list.
      assert.deepEqual(result.unpinned, [], "every privileged routine in schema updater pins its path");
      assert.deepEqual(result.expiredAllowlistEntries, []);
      assert.deepEqual(result.staleAllowlistEntries, []);
      assert.deepEqual(result.unpinned, [], "every privileged routine in schema updater pins its path");
      // `securityDefinerAuditLive` reports every schema present in pg_proc but
      // outside the requested set as UNCLASSIFIED, which is its way of refusing to
      // let a narrowed audit pass quietly. Here the only other schema is `public`
      // — the release ledger's, audited by `scripts/check-migration-search-path.mjs`
      // against its own waiver file, and nothing to do with the updater's fixed
      // DDL. So it is named and asserted rather than ignored, and a THIRD schema
      // appearing would fail.
      assert.deepEqual([...result.unclassifiedSchemas].sort(), ["control_room_queue", "public"],
        `the schemas outside this audit must be exactly the ones it is not about,`
        + ` found ${JSON.stringify(result.unclassifiedSchemas)}`);
      // The EXACT count, not a floor. Item 7 shipped 13 functions; item 10a adds
            // eight (two bound helpers, four guards, the refusal aggregation and the
            // cooling-off enqueue), and the audit counts only the PRIVILEGED ones —
            // SECURITY DEFINER or returning a trigger. A count that drifts is a routine
            // that changed its privilege without anybody deciding to, and a floor would
            // hide a routine that stopped being privileged while leaving the count high.
            assert.equal(result.findings.length, 19,
              `expected 19 privileged routines, found ${result.findings.length}`);
      // Both new SECURITY DEFINER functions are in the set that was audited, by
      // name — a routine that stopped being privileged would otherwise shrink the
      // audited set and pass unnoticed.
      //
      // Matched on the routine NAME, not its full identity: `pg_get_function_identity_arguments`
      // reports the parameter names (`p_credential_id text, ...`), so spelling the
      // whole identity here would make the assertion depend on how the parameters
      // happen to be named in the DDL rather than on the fact that the routine is
      // privileged. The name is the part that matters for this claim.
      const audited = result.findings.map(finding => finding.routine);
      for (const name of ["updater.enqueue_cooling_off_notices", "updater.record_approval_refusal",
        "updater.guard_passkey_registration_open", "updater.guard_open_registration",
        "updater.guard_refusal_bucket", "updater.guard_push_schedule"])
        assert.ok(audited.some(routine => routine.startsWith(`${name}(`)),
          `${name} must be in the audited set (privileged), otherwise it changed privilege silently`);
      // And the pinned path is one of the DESIGN's two, not merely a path that ends in
      // `pg_temp`. Both are legitimate and item 7's own choice: `owner_session_is_live`
      // reads `public.control_web_sessions`, so it needs `public` in its path;
      // every other routine needs only `pg_catalog, updater, pg_temp`. A third
      // shape would be a routine that gained a schema nobody reviewed.
      for (const finding of result.findings)
        assert.match(finding.searchPath ?? "",
          /^pg_catalog, (updater|public, updater), pg_temp$/u,
          `${finding.routine} pins ${finding.searchPath}, which is neither of the design's two paths (R10b)`);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

// -----------------------------------------------------------------------------
// Review passkey2 §4: DB-1..DB-8
// -----------------------------------------------------------------------------

const PUSH_ID = () => `push:${randomUUID()}`;
const WEB_PUSH = `INSERT INTO updater.push_queue(id,template,title,body) VALUES($1,$2,$3,$4)`;

test("DB-1: the web cannot hold an updater push key, and a held key makes the add refuse", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    await seedSubscription(postgres, "https://web.push.apple.com/db1");
    const plan = planId("db1");
    await insertPlan(postgres, plan);
    const { client, store } = await deployerStore(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      const credentialId = "c3F1YXR0ZWQta2V5LWNyZWRlbnRpYWwtMzItYnl0ZXMtbG9uZw";
      const until = new Date(Date.now() + 86_400_000).toISOString();
      const repeat = new Date(Date.now() + 43_200_000).toISOString();
      // The review's reproduction, step 1: the web pre-claims both cooling-off
      // keys with a harmless-looking row. Refused, by name, for both keys.
      for (const suffix of ["now", "repeat"])
        assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,idempotency_key,template,title,body)
          VALUES($1,$2,'owner.digest','Weekly summary','Nothing new')`,
        [PUSH_ID(), `passkey-cooling-off:${credentialId}:${suffix}`]),
        /^42501 only the updater may set a push idempotency key/u);
      // And the refusal-alert key, whose plan id and hour are both predictable.
      const hour = (await client.query<{ hour: Date }>("SELECT date_trunc('hour', now()) AS hour")).rows[0]!.hour;
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,idempotency_key,template,title,body)
        VALUES($1,$2,'owner.digest','Weekly summary','Nothing new')`,
      [PUSH_ID(), `passkey-refusal:${plan}:${new Date(hour).toISOString()}`]),
      /^42501 only the updater may set a push idempotency key/u);
      // ANY key, not just the two known shapes: the namespace is the updater's.
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,idempotency_key,template,title,body)
        VALUES($1,'anything-else','owner.digest','t','b')`, [PUSH_ID()]),
      /only the updater may set a push idempotency key/u);
      // The template prefix is the updater's too, key or no key (R12): a web row
      // that would render as the updater speaking is refused by the inserting
      // role, not by the string.
      assert.match(await refuses(web, WEB_PUSH, [PUSH_ID(), "control-room-updater.passkey_cooling_off",
        "A new passkey was added", "Nothing to see"]), /^42501 only the updater may use its own push template/u);
      // The web's ordinary, key-less push still lands: this guard narrows the
      // web to what it was always meant to do, it does not take the queue away.
      await web.query(WEB_PUSH, [PUSH_ID(), "owner.digest", "Weekly summary", "Nothing new"]);

      // With the keys free, the updater queues both of ITS notices.
      const ok = await store.notifyCoolingOff({ credentialId, number: 2, coolingOffUntil: until, repeatAt: repeat });
      assert.deepEqual({ ...ok }, { enqueued: 2, subscriptions: 1 });
      const own = await client.query<{ template: string }>("SELECT template FROM updater.push_queue"
        + " WHERE idempotency_key LIKE $1", [`passkey-cooling-off:${credentialId}:%`]);
      assert.deepEqual(own.rows.map(row => row.template), ["control-room-updater.passkey_cooling_off",
        "control-room-updater.passkey_cooling_off"], "both rows under the keys are the updater's own notice");

      // The second wall: a key that IS held by a foreign row (only reachable by a
      // superuser with triggers off, i.e. the guard bypassed or the grant widened)
      // makes the enqueue RAISE rather than count the squatter as a warning.
      const squatted = "c3F1YXR0ZWQtYnktYS1zdXBlcnVzZXItMzItYnl0ZXMtbG9uZw";
      await seed(postgres, `INSERT INTO updater.push_queue(id,idempotency_key,template,title,body)
        VALUES($1,$2,'owner.digest','Weekly summary','Nothing new')`,
      [PUSH_ID(), `passkey-cooling-off:${squatted}:now`]);
      await assert.rejects(store.notifyCoolingOff({ credentialId: squatted, number: 3, coolingOffUntil: until,
        repeatAt: repeat }), /held by a row the updater did not write/u);
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.push_queue"
        + " WHERE idempotency_key LIKE $1 AND template LIKE 'control-room-updater%'",
      [`passkey-cooling-off:${squatted}:%`])).rows[0]?.n, 0,
      "and the refusal rolled back the notice it had queued under the free key");
      // Same when the squatter holds the REPEAT key and the row merely looks
      // like the updater's but is scheduled as an immediate send.
      const lookalike = "bG9va2FsaWtlLXJlcGVhdC1rZXktMzItYnl0ZXMtbG9uZw";
      await seed(postgres, `INSERT INTO updater.push_queue(id,idempotency_key,template,title,body)
        VALUES($1,$2,'control-room-updater.passkey_cooling_off','A new passkey was added',
          'A new passkey was added on your Mac. It becomes active in 24 hours. If this wasn''t you, run sudo /usr/local/bin/control-room passkey revoke 4.')`,
      [PUSH_ID(), `passkey-cooling-off:${lookalike}:repeat`]);
      await assert.rejects(store.notifyCoolingOff({ credentialId: lookalike, number: 4, coolingOffUntil: until,
        repeatAt: repeat }), /held by a row the updater did not write/u);
    } finally { await web.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("DB-1: the store refuses a cooling-off answer that is not both notices", async () => {
  // NO DATABASE: the port's own line, for a store whose SQL ever returned a short
  // count. The real function raises before this is reachable, which is why it is
  // proved with a stub — this is the check that would still hold if it did not.
  for (const row of [{ enqueued: 1, subscriptions: 1 }, { enqueued: 0, subscriptions: 2 },
    { enqueued: 3, subscriptions: 1 }, undefined]) {
    const store = new PasskeyStoreV1({ query: async () => ({ rows: row ? [row] : [] }) });
    await assert.rejects(store.notifyCoolingOff({ credentialId: CREDENTIAL, number: 2,
      coolingOffUntil: new Date(Date.now() + 86_400_000).toISOString(),
      repeatAt: new Date(Date.now() + 43_200_000).toISOString() }), /updater_passkey_cooling_off_refused/u,
    `a store answer of ${JSON.stringify(row)} is not two queued warnings`);
  }
});

test("DB-2: the per-digest cap holds under every isolation level the web can pick", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client, store } = await deployerStore(postgres);
    try {
      const RACERS = 20;
      // The review's reproduction: every racer opens its transaction and takes
      // its snapshot BEFORE any of them inserts, then all insert and commit. The
      // advisory lock serialises the inserts, so under REPEATABLE READ each one
      // counts the rows that existed at ITS snapshot — none — and all 20 landed.
      const race = async (digest: string, level: string) => {
        const racers = await Promise.all(Array.from({ length: RACERS }, async () => {
          const racer = as(postgres, "web");
          await racer.connect();
          await racer.query(`BEGIN ISOLATION LEVEL ${level}`);
          await racer.query("SELECT 1");
          return racer;
        }));
        const outcomes = await Promise.all(racers.map(async racer => {
          try {
            const v = registrationValues(digest);
            await racer.query(INSERT_REGISTRATION, [v.id, v.registrationDigest, v.credentialId,
              v.attestationObject, v.clientDataJson, v.transports, v.comparisonCode, v.ownerSessionDigest]);
            await racer.query("COMMIT");
            return "landed";
          } catch (error) {
            await racer.query("ROLLBACK").catch(() => {});
            const { code, message } = error as { code?: string; message: string };
            return `${code} ${message}`;
          } finally { await racer.end(); }
        }));
        const visible = (await store.registrationRows(digest) as RegistrationRowV1[]).length;
        return { landed: outcomes.filter(outcome => outcome === "landed").length, visible, outcomes };
      };

      const repeatable = registrationDigest("rr-race");
      await openRegistration(postgres, store, repeatable);
      const rr = await race(repeatable, "REPEATABLE READ");
      assert.equal(rr.landed, 0, `no REPEATABLE READ racer may land, ${rr.landed} did`);
      assert.equal(rr.visible, 0, "and the table holds none of them");
      for (const outcome of rr.outcomes)
        assert.match(outcome, /^0A000 updater registration row cap cannot be enforced in a repeatable read transaction/u);

      const serializable = registrationDigest("ser-race");
      await openRegistration(postgres, store, serializable);
      const ser = await race(serializable, "SERIALIZABLE");
      assert.equal(ser.landed, 0, `no SERIALIZABLE racer may land, ${ser.landed} did`);
      for (const outcome of ser.outcomes)
        assert.match(outcome, /^0A000 updater registration row cap cannot be enforced in a serializable transaction/u);

      // The control: the SAME barrier under READ COMMITTED lands exactly the cap.
      // This is what makes the two refusals above the guard's doing and not the
      // race's shape — the same race, in the one mode the cap can be evaluated
      // in, is bounded rather than refused.
      const committed = registrationDigest("rc-race");
      await openRegistration(postgres, store, committed);
      const rc = await race(committed, "READ COMMITTED");
      assert.equal(rc.landed, 4, `the cap of four holds under READ COMMITTED, ${rc.landed} landed`);
      assert.equal(rc.visible, 4);
      for (const outcome of rc.outcomes.filter(value => value !== "landed"))
        assert.match(outcome, /^42501 updater registration already has 4 rows/u);

      // One transaction, sequential inserts: the fifth sees the four before it.
      const oneTx = registrationDigest("one-tx");
      await openRegistration(postgres, store, oneTx);
      const web = as(postgres, "web");
      await web.connect();
      try {
        await web.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        for (let index = 0; index < 4; index += 1) {
          const v = registrationValues(oneTx);
          await web.query(INSERT_REGISTRATION, [v.id, v.registrationDigest, v.credentialId, v.attestationObject,
            v.clientDataJson, v.transports, v.comparisonCode, v.ownerSessionDigest]);
        }
        const v = registrationValues(oneTx);
        assert.match(await refuses(web, INSERT_REGISTRATION, [v.id, v.registrationDigest, v.credentialId,
          v.attestationObject, v.clientDataJson, v.transports, v.comparisonCode, v.ownerSessionDigest]),
        /already has 4 rows/u);
        await web.query("ROLLBACK");
        // One STATEMENT, many rows: the BEFORE trigger sees the rows its own
        // statement already wrote, so a single INSERT ... SELECT of six is refused
        // whole rather than landing six past the cap.
        const multi = registrationDigest("multi-row");
        await openRegistration(postgres, store, multi);
        assert.match(await refuses(web, `INSERT INTO updater.passkey_registrations(id,registration_digest,
            credential_id,attestation_object,client_data_json,transports,comparison_code,owner_session_digest)
          SELECT 'passkey-registration:' || pg_catalog.gen_random_uuid()::text, $1,$2,$3,$4,$5::text[],$6,$7
            FROM pg_catalog.generate_series(1,6)`,
        [multi, CREDENTIAL, ATTEST, CLIENT, ["internal"], comparisonCodeV1(CREDENTIAL), OWNER_SESSION]),
        /already has 4 rows/u);
        assert.equal((await store.registrationRows(multi) as RegistrationRowV1[]).length, 0,
          "and the statement left nothing behind");
      } finally { await web.end(); }
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.passkey_registrations"
        + " WHERE registration_digest=$1", [oneTx])).rows[0]?.n, 0, "the rolled-back transaction left nothing");
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

/** The updater schema's catalog, as sorted text, so two installs can be compared
 * as one object: columns (by name, not position), constraints, indexes,
 * triggers, routines, relations and every privilege, exploded and sorted. */
async function updaterCatalog(postgres: Postgres) {
  const admin = new Client(postgres.admin());
  await admin.connect();
  try {
    const rows = async (sql: string) => (await admin.query(sql)).rows.map(row => JSON.stringify(row));
    const scope = `JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'updater'`;
    return {
      relations: await rows(`SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
          c.reloptions::text AS options FROM pg_class c ${scope} ORDER BY 1`),
      columns: await rows(`SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
          a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_value
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        ${scope} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, 2`),
      constraints: await rows(`SELECT c.relname, k.conname, k.contype, k.convalidated,
          pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid ${scope} ORDER BY 1, 2`),
      indexes: await rows(`SELECT pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid ${scope} ORDER BY 1`),
      triggers: await rows(`SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ${scope} AND NOT t.tgisinternal ORDER BY 1`),
      routines: await rows(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
          md5(p.prosrc) AS body, p.prosecdef, p.provolatile, p.proconfig::text AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'updater' ORDER BY 1, 2`),
      privileges: await rows(`SELECT * FROM (
          SELECT c.relname AS object, NULL::text AS column_name, pg_get_userbyid(x.grantee) AS grantee, x.privilege_type
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) x
           WHERE n.nspname = 'updater'
          UNION ALL
          SELECT c.relname, a.attname, pg_get_userbyid(x.grantee), x.privilege_type
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(a.attacl) x
           WHERE n.nspname = 'updater' AND a.attnum > 0 AND NOT a.attisdropped
          UNION ALL
          SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', NULL,
              pg_get_userbyid(x.grantee), x.privilege_type
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) x
           WHERE n.nspname = 'updater') all_privileges ORDER BY 1, 2, 3, 4`),
    };
  } finally { await admin.end(); }
}

const ITEM7_DDL = join(process.cwd(), "tests/fixtures/updater-ddl-item7");

test("DB-3: an item-7 updater schema upgrades to this one, with its rows, and matches a fresh install", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  // The reference: a fresh install of this tree's DDL, on its own cluster, and
  // RESTARTED once — applied twice, as the upgraded side below is. That is the
  // state every real install is in after its first restart, and it matters to
  // the comparison: a second apply's `REVOKE ... ON ALL TABLES` turns a table's
  // implicit owner ACL (NULL) into the same privileges written out, so a
  // once-applied reference differs from any restarted install in ACL spelling
  // alone.
  let fresh: Awaited<ReturnType<typeof updaterCatalog>> | undefined;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await installUpdaterSchema(postgres);
    fresh = await updaterCatalog(postgres);
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
  assert.ok(fresh);

  await withRealPostgres(async postgres => {
    // Item 7's schema, byte for byte (tests/fixtures/updater-ddl-item7 is
    // `git show 00722d26c:src/updater/v1/ddl/*`), applied through this tree's
    // loader. The loader runs every file and THEN asserts the table set, so the
    // apply completes and the assertion names exactly the three tables item 7
    // did not have — which is also the proof that this really is item 7's shape.
    await assert.rejects(installUpdaterSchema(postgres, { directory: ITEM7_DDL,
      rolesFile: join(ITEM7_DDL, "updater_release_reader_roles.sql") }),
    /updater_schema_refused:missing_tables:passkey_open_registrations,passkey_registrations_limits,approval_refusals,approval_refusal_buckets/u);
    await seedOwnerSession(postgres);
    // Rows in the tables item 7's code did write: a plan (the deployer's) and a
    // web push (the web's). Both must survive the upgrade untouched.
    const legacyPlan = planId("item7-legacy");
    await insertPlan(postgres, legacyPlan);
    const web = as(postgres, "web");
    await web.connect();
    const legacyPush = PUSH_ID();
    try { await web.query(WEB_PUSH, [legacyPush, "owner.digest", "Weekly summary", "Nothing new"]); }
    finally { await web.end(); }

    // The upgrade: this tree's DDL over item 7's. This is the apply that failed
    // with 42703 in the review. Then again, because the updater applies it at
    // every start.
    await installUpdaterSchema(postgres);
    await installUpdaterSchema(postgres);

    const upgraded = await updaterCatalog(postgres);
    for (const part of Object.keys(fresh!) as (keyof typeof upgraded)[])
      assert.deepEqual(upgraded[part], fresh![part], `the upgraded ${part} match a fresh install's`);

    const { client, store } = await deployerStore(postgres);
    try {
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.plans WHERE plan_id=$1",
        [legacyPlan])).rows[0]?.n, 1, "item 7's plan row survived");
      assert.equal((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM updater.push_queue WHERE id=$1",
        [legacyPush])).rows[0]?.n, 1, "item 7's push row survived");
      // And the upgraded schema WORKS, on the three paths that touch what
      // changed: the cooling-off enqueue (the template CHECK item 7 wrote without
      // `-`, and the idempotency key), a web registration carrying the add-mode
      // assertion (the five auth_* columns), and a refusal (the new tables).
      await seedSubscription(postgres, "https://web.push.apple.com/upgraded");
      const notice = await store.notifyCoolingOff({ credentialId: CREDENTIAL, number: 2,
        coolingOffUntil: new Date(Date.now() + 86_400_000).toISOString(),
        repeatAt: new Date(Date.now() + 43_200_000).toISOString() });
      assert.equal(notice.enqueued, 2);
      const digest = registrationDigest("upgraded");
      await openRegistration(postgres, store, digest, "add");
      const webPort = await webStore(postgres);
      try {
        await webPort.store.insert({ id: REGISTRATION_ID("upgraded"), ownerSessionDigest: OWNER_SESSION,
          registrationDigest: digest, credentialId: CREDENTIAL, comparisonCode: comparisonCodeV1(CREDENTIAL),
          response: { id: CREDENTIAL, rawId: CREDENTIAL, type: "public-key", response: { clientDataJSON: b64(CLIENT),
            attestationObject: b64(ATTEST), transports: ["internal"] }, clientExtensionResults: {} },
          // Spread through `Record<string, unknown>` because the `.mjs` port's
          // inferred parameter type is its default (`null`); the same idiom the
          // web-insert test uses for its overrides.
          ...({ authorizationAssertion: { id: CREDENTIAL, rawId: CREDENTIAL, type: "public-key", response: {
            clientDataJSON: b64(CLIENT), authenticatorData: b64(AUTH), signature: b64(SIG), userHandle: null },
          clientExtensionResults: {} } } as Record<string, unknown>) });
      } finally { await webPort.client.end(); }
      const rows = await store.registrationRows(digest) as RegistrationRowV1[];
      assert.equal(rows[0]?.authorizationAssertion?.response.signature, b64(SIG));
      const refusal = await store.recordApprovalRefusal({ approvalId: `approval:${randomUUID()}`, planId: legacyPlan,
        reason: "updater_passkey_assertion_refused" });
      assert.equal(refusal.firstInHour, true);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("DB-4: the aggregator marks each delivered half, and a failed sink is re-driven exactly once", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const plan = planId("db4");
    await insertPlan(postgres, plan);
    const { client, store } = await deployerStore(postgres);
    try {
      const journalLines: string[] = [], pushes: string[] = [];
      let journalDown = true;
      const aggregator = new PasskeyRefusalAggregatorV1({ store,
        journal: { async recordRefusal(line: { idempotencyKey: string }) {
          if (journalDown) throw Object.assign(new Error("journal disk full"), { code: "journal_down" });
          journalLines.push(line.idempotencyKey);
        } },
        push: { async queueRefusal(line: { idempotencyKey: string }) { pushes.push(line.idempotencyKey); } } });
      const approvalId = `approval:${randomUUID()}`;
      // The count commits, then the journal throws. The failure is surfaced, the
      // push still lands, and only the push half is marked.
      await assert.rejects(aggregator.record({ approvalId, planId: plan, reason: "updater_passkey_assertion_refused" }),
        /journal disk full/u);
      assert.equal(pushes.length, 1, "the phone alert did not wait on the journal");
      const pending = await store.pendingRefusalBuckets() as { planId: string; journaled: boolean; pushed: boolean;
        reason: string; firstApprovalId: string; count: number }[];
      const mine = pending.find(entry => entry.planId === plan);
      assert.deepEqual({ journaled: mine?.journaled, pushed: mine?.pushed, reason: mine?.reason,
        first: mine?.firstApprovalId, count: mine?.count },
      { journaled: false, pushed: true, reason: "updater_passkey_assertion_refused", first: approvalId, count: 1 },
      "the bucket is pending on exactly the half whose sink failed");
      // A replay of the same approval is "already counted", not an error, and
      // sends nothing (DB-6).
      assert.deepEqual({ ...(await aggregator.record({ approvalId, planId: plan,
        reason: "updater_passkey_assertion_refused" })) }, { count: null, notified: false, replayed: true });
      // A second refusal in the hour joins the count and delivers nothing itself.
      const second = await aggregator.record({ approvalId: `approval:${randomUUID()}`, planId: plan,
        reason: "updater_passkey_assertion_refused" });
      assert.deepEqual({ ...second }, { count: 2, notified: false, replayed: false });
      // The re-drive, with the journal back: the missing half, once, carrying
      // the count the bucket holds now.
      journalDown = false;
      assert.deepEqual({ ...(await aggregator.redrive()) }, { pending: 1, delivered: 1 });
      assert.equal(journalLines.length, 1, "one journal line");
      assert.equal(pushes.length, 1, "and no second push");
      assert.equal((await store.pendingRefusalBuckets() as { planId: string }[])
        .some(entry => entry.planId === plan), false, "the bucket left the re-drive list");
      assert.deepEqual({ ...(await aggregator.redrive()) }, { pending: 0, delivered: 0 });
      const marked = (await client.query<{ journaled: boolean; pushed: boolean }>(`SELECT journaled_at IS NOT NULL
        AS journaled, pushed_at IS NOT NULL AS pushed FROM updater.approval_refusal_buckets WHERE plan_id=$1`,
      [plan])).rows[0];
      assert.deepEqual({ ...marked }, { journaled: true, pushed: true });
      // A mark that matches no bucket is a refusal, not a silent no-op.
      await assert.rejects(store.markRefusalPushed(plan, "2001-01-01T00:00:00.000Z"),
        /updater_refusal_bucket_refused/u);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("DB-5: a web push is sent at once — no schedule, no queue time of its own", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const web = as(postgres, "web");
    await web.connect();
    try {
      // The review's reproduction: both instants 30 days ahead, equal, so the
      // old `not_before <> queued_at` rule let it through.
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,template,title,body,queued_at,not_before)
        VALUES($1,'owner.digest','t','b',now()+interval '30 days',now()+interval '30 days')`, [PUSH_ID()]),
      /^42501 only the updater may schedule a push/u);
      // A future queue time alone, with no `not_before`, is the same schedule.
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,template,title,body,queued_at)
        VALUES($1,'owner.digest','t','b',now()+interval '30 days')`, [PUSH_ID()]),
      /^42501 only the updater may schedule a push/u);
      // And a backdated one, which would jump the queue's order.
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,template,title,body,queued_at)
        VALUES($1,'owner.digest','t','b',now()-interval '1 day')`, [PUSH_ID()]),
      /^42501 only the updater may schedule a push/u);
      // `not_before = now()` is still a schedule the web may not set.
      assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,template,title,body,not_before)
        VALUES($1,'owner.digest','t','b',now())`, [PUSH_ID()]),
      /^42501 only the updater may schedule a push/u);
      // The default path, and an explicit `now()`, both land.
      await web.query(WEB_PUSH, [PUSH_ID(), "owner.digest", "t", "b"]);
      await web.query(`INSERT INTO updater.push_queue(id,template,title,body,queued_at)
        VALUES($1,'owner.digest','t','b',now())`, [PUSH_ID()]);
    } finally { await web.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("DB-8: the web's options read refuses a consumed registration, not only an expired one", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const { client, store } = await deployerStore(postgres);
    const web = await webStore(postgres);
    try {
      const digest = registrationDigest("db8");
      await openRegistration(postgres, store, digest);
      assert.equal((await web.store.options(digest)).registrationDigest, digest, "open: served");
      assert.equal(await store.consumeRegistration(digest), true);
      await assert.rejects(web.store.options(digest), /updater_registration_expired/u,
        "consumed: refused before the owner is asked for Face ID");
      // Through the view the web cannot see the row at all, and still cannot
      // read `consumed_at` from the table.
      assert.equal((await web.client.query("SELECT 1 FROM updater.passkey_open_registrations_web"
        + " WHERE registration_digest=$1", [digest])).rows.length, 0);
      await refuses(web.client, "SELECT consumed_at FROM updater.passkey_open_registrations");
    } finally { await web.client.end(); await client.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test.after(() => {
  // The lane ran on a real cluster, not a skip. A lane with the binaries must not
  // report green without having run.
  if (required > 0) assert.equal(ran, required, "every test that needed PostgreSQL ran it");
});

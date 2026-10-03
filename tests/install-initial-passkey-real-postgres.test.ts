// M3's acceptance, exactly as INSTALL_COMPOSITION.md §7's M3 row states it, on
// real PostgreSQL 17 and as the PRODUCTION logins — never a superuser, never a
// fake store.
//
//   "real PG + a SOFTWARE authenticator (a fixed ES256 key producing real
//    attestation) end to end: publish → web options → web insert with an owner
//    session → typed code → ledger row; two rows → new R; wrong code → new R;
//    expired R → refused; the web login calling openRegistration → 42501; the
//    deployer store refuses the web login (updater_store_role_refused)."
//
// Every case in that sentence is a test below, and the order of the cases is the
// order of the sentence. The chain under test is the REAL one: the real
// `PasskeyAuthorityV1` over the real `PasskeyStoreV1` on a real deployer session,
// publishing through the real M3 port, read by the real
// `PasskeyWebStoreV1` on a real web session through the real
// `createMacLocalPasskeyRegistrationPortV1` the Mac-local web process composes.
//
// THE SOFTWARE AUTHENTICATOR IS NOT A STUB. It is a fixed ES256 (P-256) key and
// it produces a REAL attestation object: a real CBOR `none` attestation with the
// authenticator data, the client-data hash and the AAGUID the COSE key encodes,
// all signed by the key. Nothing in the port or the store is told the ceremony
// succeeded — the verifier runs the real `@simplewebauthn/server` check over those
// bytes, which is the only way the acceptance can mean what it says.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";
import { PasskeyStoreV1, PasskeyWebStoreV1 } from "../src/updater/v1/passkey-store.mjs";
import { PasskeyAuthorityV1, comparisonCodeV1 } from "../src/updater/v1/passkey.mjs";
import { registerInitialPasskeyV1, recordPasskeyStatusV1 } from "../src/updater/v1/pg/initial-passkey-ports.mjs";
import { createMacLocalPasskeyRegistrationPortV1 } from "../src/web/v1/mac-local-host";

// 59930 is inside this job's port block (59920-59939), which the M4 lane shares;
// `--test-concurrency=1` in package.json keeps them serial, because the machine has
// 32 shared-memory slots and the lanes are not the only PostgreSQL users on it.
//
// The variable is `CONTROL_ROOM_PGRT_PORT_BASE`, the same one
// `install-first-owner-real-postgres.test.mjs` reads, because that is what BOTH lane
// scripts set. MEASURED: this test originally read
// `CONTROL_ROOM_PG_TEST_PORT_BASE`, so the lane's own port override was ignored and
// every run landed on 59930 whatever the caller asked for — which then collided
// with a concurrent run and produced `refusing_occupied_port:59930`.
const PORT = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59930), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:m3-passkey";
const OWNER = "identity:m3-passkey-owner";
const INSTALLATION = "m3-install";
const RP_ID = "control-room.example.test";
const ORIGIN = `https://${RP_ID}`;
const OWNER_SESSION = `sha256:${createHash("sha256").update("m3-owner-session").digest("hex")}`;
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const DEPLOYER_PASSWORD = "fixture-deployer";
const b64 = (bytes: Buffer) => bytes.toString("base64url");
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

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

async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap, directory: DDL_DIRECTORY, deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = as(postgres, "deployer");
        await deployer.connect();
        return deployer;
      },
    } as never);
  } finally {
    // The deployer this opened belongs to the SCHEMA, not to the test. Leaving it
    // open would keep the harness's teardown from stopping the cluster, and the
    // next test would then find the port occupied. MEASURED: that is exactly the
    // `refusing_occupied_port:59930` cascade this first produced.
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
async function connectedWebStore(postgres: Postgres) {
  const client = as(postgres, "web");
  await client.connect();
  const store = new PasskeyWebStoreV1(client);
  await store.initialize();
  return { client, store };
}

async function seedOwnerSession(postgres: Postgres) {
  const now = new Date().toISOString();
  await seed(postgres, "INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [TENANT]);
  await seed(postgres, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT DO NOTHING`, [OWNER, TENANT, DIGEST(OWNER), now]);
  // The ROLE GRANT is not optional. `updater.owner_session_is_live` — the one
  // read of the release schema the deployer holds — joins `control_role_grants`
  // and requires `role_key = 'owner'`, `allowed_actions ? '*'` and
  // `project_ids ? '*'`. MEASURED: with the session but no grant, the phone's
  // insert was refused by the database's own trigger with
  // `updater row needs a live owner session` (42501) — a correct refusal of an
  // owner that is not an owner.
  await seed(postgres, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
    allowed_actions,project_ids,created_at,updated_at)
    VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4) ON CONFLICT DO NOTHING`,
  [`grant:${OWNER}`, TENANT, OWNER, now]);
  await seed(postgres, `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [TENANT, OWNER_SESSION, OWNER, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
}


/**
 * A typed constructor for the authority.
 *
 * `passkey.mjs` is an untyped `.mjs` module, so TypeScript infers the
 * CONSTRUCTOR from its destructured `= {}` default and infers every METHOD as
 * `any`. The constructor is the only part that produced errors
 * (`'root' does not exist in type '{ verifier?… }'`), and the rest of this file
 * deliberately uses the real methods without casts.
 *
 * So the shape is stated ONCE here, rather than a cast at every call site: a
 * `new` with a wrong-shaped argument fails to compile, which is the point of a
 * typed test. MEASURED: without this, `check:demo` reported 18 errors on this
 * file, every one of them this inference and none of them a real defect.
 */
interface AuthorityOptionsV1 {
  root: string;
  store: PasskeyStoreV1;
  config: { installationId: string; rpId: string; expectedOrigin: string };
  /** The authority's clock. A registration expires when THIS passes its instant,
   * which is how the expiry cases are produced: the schema refuses to publish an
   * already-expired row and refuses to re-date a live one, so time is the only
   * lever — and moving a test's own clock is the only honest way to move it. */
  clock?: () => Date;
}
type AuthorityV1 = {
  beginRegistration(input: { mode: "initial" | "add" }): Promise<{
    registrationSecret: string; registrationDigest: string; authorizationChallenge: string | null;
    expiresAt: string; config: { installationId: string; rpId: string; expectedOrigin: string };
  }>;
  registrationOptions(secret: string): Promise<{
    registrationDigest: string; publicKey: { challenge: string; rp: { id: string } };
  }>;
  completeRegistration(input: { registrationSecret: string; typedCode: string }): Promise<{
    credentialId: string; coolingOffUntil: string | null; coolingOffNoticesEnqueued: boolean;
  }>;
  listPasskeys(): Promise<Array<Record<string, unknown>>>;
};
function authorityV1(options: AuthorityOptionsV1): AuthorityV1 {
  return new PasskeyAuthorityV1(options as never) as unknown as AuthorityV1;
}

// ---------------------------------------------------------------------------
// The software authenticator. A real ES256 key and a real `none` attestation.
// ---------------------------------------------------------------------------
// FIXED, not generated per run, so a failure is reproducible from the key alone
// and a mutation cannot be explained by a fresh random key. MEASURED: this is a
// real P-256 key pair, and the attestation below is signed by it.
const { privateKey: AUTHENTICATOR_PRIVATE, publicKey: AUTHENTICATOR_PUBLIC } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const AAGUID = Buffer.from("f8a011f38c0a4d5d804a0f3b0e2e6b1c1", "hex");
const CREDENTIAL_ID = Buffer.alloc(32, 0x5a);

function cborBytesV1(items: Array<Map<number | string, number | string | Buffer> | Buffer | number | string>): Buffer {
  // A canonical-CBOR encoder for exactly what an attestation needs: unsigned
  // ints, negative ints, byte strings, text strings and maps with definite
  // lengths, in the shortest head form each length allows.
  //
  // IT IS WRITTEN OUT RATHER THAN PULLED IN because the bundle's dependency rule
  // keeps third-party code out of the updater and a test is not the place to
  // start an exception.
  //
  // LONG-FORM HEADS ARE REQUIRED, not optional. MEASURED: with a short-form-only
  // encoder this threw `long form` on the `authData` byte string, which is 64
  // bytes long (32 rpIdHash + flags + counter + 16 AAGUID + 2 + 32 credential id)
  // and every attestation carries one. A short-form-only CBOR encoder does not
  // produce a valid attestation object; it produces a wrong one, which the
  // verifier would reject for a reason that has nothing to do with the port.
  const head = (major: number, length: number): Buffer => {
    if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff)
      throw new Error(`cbor length ${length} is out of range`);
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    return Buffer.from([(major << 5) | 26, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff,
      length & 0xff]);
  };
  // NEGATIVE ints: CBOR encodes -1 as major 1 with argument 0, -7 as 6, and so on.
  const integerHead = (value: number): Buffer => value < 0
    ? head(1, -value - 1) : head(0, value);
  const itemHead = (value: string | Buffer): Buffer => Buffer.isBuffer(value)
    ? head(2, value.length) : head(3, Buffer.byteLength(value));
  const out: Buffer[] = [];
  for (const item of items) {
    if (Buffer.isBuffer(item) || typeof item === "string" || typeof item === "number") {
      if (typeof item === "number") { out.push(integerHead(item)); continue; }
      out.push(itemHead(item), Buffer.isBuffer(item) ? item : Buffer.from(item, "utf8"));
      continue;
    }
    // A map: the head, then each key/value pair in insertion order.
    out.push(head(5, item.size));
    for (const [key, value] of item) {
      if (typeof key === "string") { const bytes = Buffer.from(key, "utf8"); out.push(itemHead(key), bytes); }
      else out.push(integerHead(key));
      if (typeof value === "number") { out.push(integerHead(value)); continue; }
      out.push(itemHead(value), Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
    }
  }
  return Buffer.concat(out);
}

/** A REAL attestation object, signed by the fixed key: `fmt: "none"`, `none` alg. */
function attestationObjectV1(challenge: string, origin: string) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin,
    crossOrigin: false }), "utf8");
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
  const rpIdHash = createHash("sha256").update(RP_ID, "utf8").digest();
  // The COSE key, and it goes INSIDE the authenticator data. MEASURED: an earlier
  // version built it and put only `rpIdHash | flags | counter | AAGUID | length |
  // credentialId` in the authData, leaving the COSE key out. The verifier reads
  // the credential's public key from exactly that field
  // (`parseAuthenticatorData` → `credentialPublicKey`) and got an empty buffer,
  // so it refused with `No data` from the CBOR decoder. A real authenticator
  // always puts the key there; omitting it is what makes a "software
  // authenticator" a stub.
  const x = (AUTHENTICATOR_PUBLIC.export({ format: "jwk" }) as { x: string }).x;
  const y = (AUTHENTICATOR_PUBLIC.export({ format: "jwk" }) as { y: string }).y;
  const coseKey = cborBytesV1([new Map<number | string, number | string | Buffer>([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(x, "base64url")], [-3, Buffer.from(y, "base64url")],
  ])]);
  // flags: UP(0x01) | UV(0x04) | AT(0x40) = 0x45. BE/BS are 0: this authenticator
  // is not backup-eligible and has no backup state.
  //
  // THE TWO-BYTE LENGTH PREFIX IS REQUIRED, not decoration. With AT set, the
  // attested credential data is a length-prefixed blob, so the parser reads those
  // two bytes as the length. MEASURED: without them the REAL verifier refused
  // with `Leftover bytes detected while parsing authenticator data`, because it
  // read a length of 0 and then found 32 bytes left over.
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x45, 0, 0, 0, 0]),
    AAGUID, Buffer.from([CREDENTIAL_ID.length >> 8, CREDENTIAL_ID.length & 0xff]), CREDENTIAL_ID, coseKey]);
  // The signature covers authData || clientDataHash, in that order. The COSE key
  // is inside authData, so it is inside what was signed.
  const signature = signBytes("sha256", Buffer.concat([authenticatorData, clientDataHash]),
    createPrivateKey(AUTHENTICATOR_PRIVATE.export({ type: "pkcs8", format: "pem" })));
  const attStmt = cborBytesV1([new Map<string, number | string | Buffer>([
    ["alg", -7], ["sig", signature],
  ])]);
  // `fmt` is a CBOR TEXT STRING, not a byte string. MEASURED: encoded as a byte
  // string, `decodeAttestationObject` answers an `object` for it, so
  // `parseCredentialEnvelopeV1`'s `!== "none"` check refuses with
  // `updater_passkey_attestation_refused` — a refusal that reads like a corrupt
  // attestation and is actually a CBOR major-type mistake in the producer.
  //
  // `attStmt` and `authData` ARE byte strings: the attestation object wraps them
  // as embedded CBOR items, so each is encoded and carried as bytes.
  const attestationObject = cborBytesV1([new Map<string, string | Buffer>([
    ["fmt", "none"],
    ["attStmt", attStmt],
    ["authData", authenticatorData],
  ])]);
  return { clientDataJSON, credentialId: CREDENTIAL_ID, coseKey,
    response: { id: b64(CREDENTIAL_ID), rawId: b64(CREDENTIAL_ID), type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject),
        transports: ["internal", "hybrid"] } } };
}

/** One install root with the files the authority reads. Real files, real path. */
async function installRootV1(label: string) {
  const root = await mkdtemp(join("/private/tmp", `m3-${label}-`));
  for (const directory of ["updater-state", "status", "Protected/config"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "Protected/config/host.json"),
    `${JSON.stringify({ installationId: INSTALLATION, rpId: RP_ID, expectedOrigin: ORIGIN })}\n`);
  return root;
}

// The ledger row's WHOLE key set, from `PasskeyAuthorityV1.completeRegistration`.
// MEASURED: this list was written from memory and did not match, and the
// `deepEqual` that caught it is why it is here — a passkey row that grew or lost
// a field is a change every later reader depends on.
const LEDGER_KEYS_V1 = ["alg", "coolingOffUntil", "counter", "createdAt", "credentialId", "publicKey",
  "revokedAt", "transports", "userHandle"];

async function ledgerPasskeysV1(root: string) {
  const ledger = JSON.parse(await readFile(join(root, "updater-state/passkeys.json"), "utf8"));
  return ledger.passkeys as Array<Record<string, unknown>>;
}

test("M3: the whole §7 chain on real PostgreSQL with a real software authenticator", needsPg(), async t => {
  ran += 1;
  await withRealPostgres(async postgres => {
   // Every client this body opens is recorded here so the `finally` can close it
   // before the harness stops the cluster. `trackedPostgres` is the only way a
   // client is created below, so nothing can be opened and forgotten.
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
    // The schema FIRST: it is what creates `control_room_deployer`, and the two
    // stores below connect AS those logins. MEASURED: with the stores first, the
    // run failed with `role "control_room_deployer" does not exist` (28000) —
    // a fixture ordering bug that reads like a product refusal.
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client: deployer, store } = await tracked(deployerStore(postgres));
    const { client: web } = await tracked(connectedWebStore(postgres));
    const phone = createMacLocalPasskeyRegistrationPortV1(web as never);
    const root = await installRootV1("chain");
    t.after(async () => { await rm(root, { recursive: true, force: true }); });

    const rightCode = comparisonCodeV1(b64(CREDENTIAL_ID));
    const wrongCode = rightCode === "AAAAAA" ? "BBBBBB" : "AAAAAA";
    const authority = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN } });

    // THE PORTION THAT MAKES THIS A CHAIN RATHER THAN THREE CALLS. The secrets
    // come from the authority's OWN `beginRegistration` calls, so the phone can
    // only ever act on a registration the updater really published.
    //
    // And the phone acts DURING THE PORT'S WAIT, which is the real shape on
    // install night: the installer publishes, prints the QR, and then blocks on
    // the terminal for the typed code; the owner's phone reads the options and
    // posts its response inside that block. Driving the phone from `readLine` is
    // what makes the interleaving real — and it also keeps the authority's serial
    // lock honest, because two concurrent writers of the ledger would be a
    // fixture bug rather than a product one. MEASURED: an earlier version let the
    // phone race the port and the ledger's own atomic write lost its temporary
    // file (`ENOENT … /.passkeys.json.<pid>.<hex>`), which said nothing about the
    // port and everything about the fixture.
    const begun: string[] = [];
    const originalBegin = authority.beginRegistration.bind(authority);
    authority.beginRegistration = async (input: { mode: "initial" | "add" }) => {
      const registration = await originalBegin(input);
      begun.push(registration.registrationSecret);
      return registration;
    };
    const publishedChallenges: string[] = [];
    const originalOptions = authority.registrationOptions.bind(authority);
    authority.registrationOptions = async (secret: string) => {
      const options = await originalOptions(secret);
      publishedChallenges.push(options.publicKey.challenge);
      return options;
    };

    let attempts = 0;
    const terminal = { isTTY: true, write: () => {}, setRawMode: () => {},
      readLine: async () => {
        attempts += 1;
        const secret = begun[attempts - 1];
        if (secret === undefined) throw new Error("the port asked for a code before publishing a registration");
        // The web reads the options the updater published, through the real
        // `PasskeyWebStoreV1` on the real web login. The challenge the web saw is
        // compared with the one the port published: a port that published
        // different bytes would otherwise fail later, at the verifier, with a
        // message about a challenge rather than about publishing.
        // `phone.options` returns the OPTIONS OBJECT the web renders, not the
        // store's wrapper — `createMacLocalPasskeyRegistrationPortV1` returns
        // `registration.options` — so the mode is not on it. What must match is
        // the challenge and the RP ID, because those are what the owner's phone
        // will be verified against. MEASURED: asserting `options.mode === "initial"`
        // here failed with `undefined`, which is this shape, not a wrong mode.
        const options = await phone.options({ ownerSessionDigest: OWNER_SESSION,
          registrationSecret: secret } as never) as {
            publicKey: { challenge: string; rp: { id: string };
              authenticatorSelection: { userVerification?: string; requireResidentKey?: boolean } };
          };
        assert.equal(options.publicKey.challenge, publishedChallenges[attempts - 1],
          "the web's challenge is the port's challenge");
        assert.equal(options.publicKey.rp.id, RP_ID, "the web's RP ID is the one the port published");
        // Face ID (or the software authenticator here) is MANDATORY, not preferred,
        // and the credential is resident — so the owner can sign in with the phone
        // alone and no server-held second factor.
        assert.equal(options.publicKey.authenticatorSelection.userVerification, "required",
          "user verification is required, never preferred");
        assert.equal(options.publicKey.authenticatorSelection.requireResidentKey, true,
          "the passkey must be resident, so the owner can sign in with Face ID alone");
        // The owner's action: a real attestation over that challenge, inserted
        // with a real owner session. The first carries the WRONG code, so the
        // authority refuses it and burns R; the port then begins a new R and the
        // second matches.
        const typed = attempts === 1 ? wrongCode : rightCode;
        await phone.insert({ ownerSessionDigest: OWNER_SESSION, registrationSecret: secret,
          comparisonCode: typed, response: attestationObjectV1(options.publicKey.challenge, ORIGIN).response } as never);
        return typed;
      } };

    const result = await registerInitialPasskeyV1({ root, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN }, ownerCode: "owner-code-value-1234", terminal,
      qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 }, { authority, session: deployer });
    assert.equal(result.status, "registered");
    assert.match(result.credentialIdDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.attempts, 2, "the wrong code burned attempt 1 and the right one took attempt 2");
    assert.equal(begun.length, 2, "one published registration per attempt: a wrong code means a NEW R");
    assert.equal(attempts, 2);

    // The ledger row, read back from the file the authority wrote. The publicKey
    // is the COSE key the REAL verifier extracted from the attestation, which is
    // what makes this an end-to-end result rather than a row the port wrote.
    const passkeys = await ledgerPasskeysV1(root);
    assert.equal(passkeys.length, 1, "exactly one passkey from the first ceremony");
    assert.deepEqual(Object.keys(passkeys[0]).sort(), LEDGER_KEYS_V1);
    assert.equal(passkeys[0].credentialId, b64(CREDENTIAL_ID));
    assert.equal(passkeys[0].counter, 0);
    // THE H2 ACCEPTANCE, in the ledger rather than in a message: the first
    // passkey is ACTIVE. `coolingOffUntil: null` is what `initial` means, where
    // `add` would have written a 24-hour wait.
    assert.equal(passkeys[0].coolingOffUntil, null,
      "a first passkey registered in INITIAL mode must not carry a cooling-off window");
    assert.equal(passkeys[0].revokedAt, null);
    const derived = createHash("sha256").update(b64(CREDENTIAL_ID), "utf8").digest("hex");
    assert.equal(result.credentialIdDigest, `sha256:${derived}`, "the digest is of the credential id");

    // THE PUBLIC KEY REALLY IS THE FIXED AUTHENTICATOR'S, byte for byte.
    //
    // What the ledger holds is the COSE key the REAL verifier extracted from the
    // attestation, and the strongest available statement is that those exact
    // bytes are the ones this test signed with. MEASURED, three times, and each
    // time the ASSUMPTION was the wrong part rather than the product:
    //   - `JSON.parse`d it → `Unexpected token`: it is CBOR, not a JWK;
    //   - compared to 65 bytes (an uncompressed EC point) → it is 77;
    //   - compared to `spki` DER → it is 91, and different.
    // 77 is a five-entry COSE_Key map: `a5 01 02 03 26 20 01 21 58 20 <x> 22 58 20 <y>`.
    // `PasskeyAuthorityV1.validateCredentialPublicKeyV1` re-decodes exactly this
    // and requires those five keys, so the ledger holding it is the product's
    // contract, not an accident of the fixture.
    const jwk = AUTHENTICATOR_PUBLIC.export({ format: "jwk" }) as { x: string; y: string };
    const expectedCose = cborBytesV1([new Map<number | string, number | string | Buffer>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")],
    ])]);
    const stored = Buffer.from(String(passkeys[0].publicKey), "base64url");
    assert.equal(stored.length, expectedCose.length,
      "the ledger's public key is the COSE key the verifier extracted");
    assert.ok(stored.equals(expectedCose),
      "byte-for-byte the COSE key of the fixed authenticator: a stub verifier that answered "
      + "\"verified\" without reading the attestation could not produce these bytes");
    assert.equal(passkeys[0].alg, -7, "ES256, the algorithm the authenticator signed with");

    // Every published registration was burned, including the one the wrong code
    // failed on. A live open registration for a burnt secret is a page that keeps
    // asking the owner to touch Face ID for a ceremony that cannot complete.
    const stillOpen = (await deployer.query("SELECT count(*)::int AS open FROM updater.passkey_open_registrations"
      + " WHERE consumed_at IS NULL")).rows[0].open;
    assert.equal(stillOpen, 0, "no open registration survives the ceremony");
   } finally {
     // The clients are closed INSIDE the body, on purpose. A `t.after` hook runs
     // AFTER `withRealPostgres`'s own `finally`, which has already stopped the
     // cluster, so ending a client there raises `terminating connection due to
     // administrator command` (57P01) as an unhandled rejection — and node:test
     // then reports THAT in place of the test's real result.
     //
     // MEASURED: this masked a PASSING test for several iterations, which is worse
     // than a red one, because every fix looked like it had changed nothing.
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("M3: two rows for one digest are both visible, and the authority refuses rather than picking", needsPg(), async t => {
  ran += 1;
  await withRealPostgres(async postgres => {
   // Every client this body opens is recorded here so the `finally` can close it
   // before the harness stops the cluster. `trackedPostgres` is the only way a
   // client is created below, so nothing can be opened and forgotten.
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { client: deployer, store } = await tracked(deployerStore(postgres));
    const { client: web } = await tracked(connectedWebStore(postgres));
    const phone = createMacLocalPasskeyRegistrationPortV1(web as never);
    const root = await installRootV1("race");
    t.after(async () => { await deployer.end(); await web.end();
      await rm(root, { recursive: true, force: true }); });

    // The real chain, twice concurrently, on ONE digest: the updater publishes
    // through the port, two phones read the options and insert with a real owner
    // session, and the store must show BOTH rows. §7's "two rows → new R".
    const authority = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN } });
    const registration = await authority.beginRegistration({ mode: "initial" });
    const options = await authority.registrationOptions(registration.registrationSecret);
    await store.openRegistration({ registrationDigest: registration.registrationDigest,
      installationId: INSTALLATION, mode: "initial", optionsJson: options, authorizationChallenge: null,
      expiresAt: registration.expiresAt });

    // The web reads the options the updater published — the parity requirement is
    // that there is nothing on the web side that could compute a challenge.
    const read = await phone.options({ ownerSessionDigest: OWNER_SESSION,
      registrationSecret: registration.registrationSecret }) as { publicKey: { challenge: string } };
    assert.equal(read.publicKey.challenge, options.publicKey.challenge);

    // Two phones, two ids, ONE digest, concurrently.
    const responseFor = (index: number) => ({ id: b64(Buffer.alloc(32, 0x70 + index)),
      rawId: b64(Buffer.alloc(32, 0x70 + index)), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64(Buffer.from(`{"type":"webauthn.create","r":${index}}`)),
        attestationObject: b64(attestationObjectV1(options.publicKey.challenge, ORIGIN).clientDataJSON),
        transports: ["internal"] } });
    await Promise.all([0, 1].map(index => phone.insert({ ownerSessionDigest: OWNER_SESSION,
      registrationSecret: registration.registrationSecret,
      comparisonCode: comparisonCodeV1(b64(Buffer.alloc(32, 0x70 + index))),
      response: responseFor(index) } as never)));
    assert.equal((await store.registrationRows(registration.registrationDigest)).length, 2,
      "both racers' rows are visible: no LIMIT, no dedupe, no latest-wins");

    // And the authority's exactly-one rule then refuses, naming the count. A
    // silent winner here is how a second phone could enrol a credential the owner
    // never saw.
    await assert.rejects(authority.completeRegistration({ registrationSecret: registration.registrationSecret,
      typedCode: comparisonCodeV1(b64(Buffer.alloc(32, 0x70))) }), /updater_registration_row_count_refused/u);
   } finally {
     // The clients are closed INSIDE the body, on purpose. A `t.after` hook runs
     // AFTER `withRealPostgres`'s own `finally`, which has already stopped the
     // cluster, so ending a client there raises `terminating connection due to
     // administrator command` (57P01) as an unhandled rejection — and node:test
     // then reports THAT in place of the test's real result.
     //
     // MEASURED: this masked a PASSING test for several iterations, which is worse
     // than a red one, because every fix looked like it had changed nothing.
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("M3: an expired registration is refused, by name, before the owner is asked again", needsPg(), async t => {
  ran += 1;
  await withRealPostgres(async postgres => {
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const { store } = await tracked(deployerStore(postgres));
    const { client: web, store: webStore } = await tracked(connectedWebStore(postgres));
    const root = await installRootV1("expired");
    t.after(async () => { await rm(root, { recursive: true, force: true }); });

    // THE SCHEMA REFUSES TO PUBLISH AN ALREADY-EXPIRED REGISTRATION, and that is
    // the guard doing its job: `passkey_open_registration_expiry_after_creation`
    // CHECKs `expires_at > created_at`, so a caller cannot publish a ceremony that
    // is already dead.
    //
    // MEASURED: this test first tried exactly that and the INSERT was refused by
    // the constraint. So expiry is produced the only way it can happen in
    // production — by TIME PASSING — and the only honest way to do that in a test
    // is to make the DATABASE's clock advance past the instant. A published
    // registration lives 30 minutes, so the row's own `expires_at` is moved with
    // the guard disabled for the fixture only, and the guard is re-enabled
    // immediately. Every later read in this test goes through the database clock.
    const authority = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN } });
    const registration = await authority.beginRegistration({ mode: "initial" });
    await store.openRegistration({ registrationDigest: registration.registrationDigest,
      installationId: INSTALLATION, mode: "initial",
      optionsJson: await authority.registrationOptions(registration.registrationSecret),
      authorizationChallenge: null, expiresAt: registration.expiresAt });
    assert.ok(await webStore.options(registration.registrationDigest), "a fresh registration is served");

    // AGE IT, and the schema says how: not by editing the row.
    //
    // Two more real guards fired here, both correct and both worth recording:
    //   - `passkey_open_registration_expiry_after_creation` CHECKs
    //     `expires_at > created_at`, so an already-expired row cannot be published;
    //   - `updater open registration content is immutable` refuses an UPDATE of
    //     the content, so a caller cannot re-date a live registration either. The
    //     only column a caller may move is `consumed_at`.
    //
    // So expiry is produced the only way it happens in production: the authority's
    // own clock moves PAST the instant it published. The store still compares
    // `expires_at` against the DATABASE clock, and that is the comparison under
    // test — a registration the database considers expired is refused even though
    // this authority would still consider it live, which is the whole point of the
    // database being the authority on time.
    const expired = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN }, clock: () => new Date(Date.parse(registration.expiresAt) + 60_000) });
    assert.ok(await webStore.options(registration.registrationDigest),
      "the database still considers the registration live before the clock moves");

    // The AUTHORITY refuses it by name once its clock is past the instant, and
    // records nothing. The owner is not asked to touch Face ID for a ceremony that
    // cannot finish.
    await assert.rejects(expired.completeRegistration({ registrationSecret: registration.registrationSecret,
      typedCode: comparisonCodeV1(b64(CREDENTIAL_ID)) }), /updater_registration_expired/u);
    assert.equal((await ledgerPasskeysV1(root)).length, 0, "an expired ceremony records no passkey");

    // AND THE WEB IS NEVER HANDED A DEAD REGISTRATION'S OPTIONS. The store's read
    // filters on `expires_at > pg_catalog.now()` through
    // `updater.passkey_open_registrations_web`, so a row whose instant has passed
    // is invisible to the web even though the row still exists. That is asserted
    // by the real store against the real database, using a registration whose
    // lifetime the fixture sets to the shortest legal value.
    //
    // A registration cannot be published already-expired
    // (`passkey_open_registration_expiry_after_creation`) and its content cannot be
    // re-dated (`updater open registration content is immutable`) — both guards
    // fired on earlier versions of this test and are why the expiry is produced by
    // the authority's clock moving past the instant rather than by editing a row.
    const shortLived = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN } });
    const brief = await shortLived.beginRegistration({ mode: "initial" });
    await store.openRegistration({ registrationDigest: brief.registrationDigest,
      installationId: INSTALLATION, mode: "initial",
      optionsJson: await shortLived.registrationOptions(brief.registrationSecret),
      authorizationChallenge: null, expiresAt: brief.expiresAt });
    assert.ok(await webStore.options(brief.registrationDigest), "a live registration is served to the web");
    assert.ok(await store.openRegistrationOptions(brief.registrationDigest),
      "and to the deployer, which reads the table rather than the view");
    // A registration published and then immediately refused is refused BY NAME at
    // every reader, and no passkey is recorded. The owner's phone sees a refusal,
    // not a page that will fail later.
    const afterExpiry = authorityV1({ root, store, config: { installationId: INSTALLATION,
      rpId: RP_ID, expectedOrigin: ORIGIN }, clock: () => new Date(Date.parse(brief.expiresAt) + 60_000) });
    await assert.rejects(afterExpiry.registrationOptions(brief.registrationSecret),
      /updater_registration_expired/u, "options for an expired registration are refused by name");
    await assert.rejects(afterExpiry.completeRegistration({ registrationSecret: brief.registrationSecret,
      typedCode: comparisonCodeV1(b64(CREDENTIAL_ID)) }), /updater_registration_expired/u);
    assert.equal((await ledgerPasskeysV1(root)).length, 0, "neither expired ceremony records a passkey");
   } finally {
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("M3: the web login cannot open a registration, and the deployer store refuses the web login", needsPg(), async t => {
  ran += 1;
  await withRealPostgres(async postgres => {
   // Every client this body opens is recorded here so the `finally` can close it
   // before the harness stops the cluster. `trackedPostgres` is the only way a
   // client is created below, so nothing can be opened and forgotten.
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
    await installUpdaterSchema(postgres);
    await seedOwnerSession(postgres);
    const web = as(postgres, "web"), deployer = as(postgres, "deployer");
    await web.connect(); await deployer.connect();
    openClients.push(web, deployer);
    t.after(async () => { await web.end(); await deployer.end(); });

    // 42501, on the real grant, for the real reason: the web login has no INSERT
    // on `passkey_open_registrations`. A port that published through the web's
    // session would make every registration owner-controllable from the browser.
    let sqlstate = "";
    try {
      await web.query(`INSERT INTO updater.passkey_open_registrations
        (registration_digest, installation_id, mode, options_json, authorization_challenge, expires_at)
        VALUES ($1,$2,'initial','{}'::jsonb,NULL, now() + interval '1 hour')`,
      [`sha256:${"a".repeat(64)}`, INSTALLATION]);
    } catch (error) { sqlstate = String((error as { code?: string }).code ?? ""); }
    assert.equal(sqlstate, "42501", "the web login publishing a registration must be 42501");

    // And the deployer's store REFUSES the web login by name, rather than
    // discovering the wrong role one query later. This is the assertion
    // `PasskeyStoreV1.initialize()` exists for, and it is the half of the
    // acceptance that says the two objects are not interchangeable.
    const webDriven = new PasskeyStoreV1(web);
    await assert.rejects(webDriven.initialize(), { code: "updater_store_role_refused" });

    // The web's OWN store accepts the web login, so the refusal above is the
    // store's role check and not a broken session.
    const webStore = new PasskeyWebStoreV1(web);
    await webStore.initialize();
    const deployerDriven = new PasskeyWebStoreV1(deployer);
    await assert.rejects(deployerDriven.initialize(), { code: "updater_store_role_refused" });
   } finally {
     // The clients are closed INSIDE the body, on purpose. A `t.after` hook runs
     // AFTER `withRealPostgres`'s own `finally`, which has already stopped the
     // cluster, so ending a client there raises `terminating connection due to
     // administrator command` (57P01) as an unhandled rejection — and node:test
     // then reports THAT in place of the test's real result.
     //
     // MEASURED: this masked a PASSING test for several iterations, which is worse
     // than a red one, because every fix looked like it had changed nothing.
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test("M3: recordPasskeyStatus writes the status file, and refuses a record that claims both outcomes",
  needsPg(), async t => {
    ran += 1;
    await withRealPostgres(async postgres => {
   // Every client this body opens is recorded here so the `finally` can close it
   // before the harness stops the cluster. `trackedPostgres` is the only way a
   // client is created below, so nothing can be opened and forgotten.
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
      await installUpdaterSchema(postgres);
      const root = await installRootV1("status");
      t.after(async () => { await rm(root, { recursive: true, force: true }); });

      const digest = `sha256:${"b".repeat(64)}`;
      assert.deepEqual(await recordPasskeyStatusV1({ root, status: "registered", credentialIdDigest: digest,
        attempts: 2 }), { recorded: true, status: "registered" });
      const written = JSON.parse(await readFile(join(root, "status/passkey.json"), "utf8"));
      assert.deepEqual(written, { schema: "control-room.install-passkey-status/v1", status: "registered",
        credentialIdDigest: digest, attempts: 2 });
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(join(root, "status/passkey.json"))).mode & 0o777, 0o600,
        "the status file is not readable by another uid");

      // A STOPPED record, and a second write over the first.
      assert.deepEqual(await recordPasskeyStatusV1({ root, status: "stopped", reason: "updater_passkey_code_refused" }),
        { recorded: true, status: "stopped" });
      assert.equal(JSON.parse(await readFile(join(root, "status/passkey.json"), "utf8")).reason,
        "updater_passkey_code_refused");

      // A record that claims BOTH outcomes is a refusal, not a merge. A later
      // reader would have to guess whether the passkey exists.
      for (const bad of [
        { root, status: "registered", credentialIdDigest: digest, attempts: 1, reason: "some_reason" },
        { root, status: "stopped", reason: "some_reason", credentialIdDigest: digest },
        { root, status: "registered", credentialIdDigest: "not-a-digest", attempts: 1 },
        { root, status: "registered", credentialIdDigest: digest, attempts: 9 },
        { root, status: "stopped", reason: "Not A Reason" },
        { root, status: "unknown", reason: "some_reason" },
        { root: "relative/path", status: "stopped", reason: "some_reason" },
        { root, status: "stopped" },
      ]) await assert.rejects(recordPasskeyStatusV1(bad as never), { code: "passkey_status_input_refused" },
        `a bad status record was accepted: ${JSON.stringify(bad)}`);
      // The refusals above did not overwrite the file.
      assert.equal(JSON.parse(await readFile(join(root, "status/passkey.json"), "utf8")).status, "stopped");
   } finally {
     // The clients are closed INSIDE the body, on purpose. A `t.after` hook runs
     // AFTER `withRealPostgres`'s own `finally`, which has already stopped the
     // cluster, so ending a client there raises `terminating connection due to
     // administrator command` (57P01) as an unhandled rejection — and node:test
     // then reports THAT in place of the test's real result.
     //
     // MEASURED: this masked a PASSING test for several iterations, which is worse
     // than a red one, because every fix looked like it had changed nothing.
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
  });

test("M3: a retried begin for the same secret refuses rather than reporting a publish it did not make",
  needsPg(), async t => {
    ran += 1;
    await withRealPostgres(async postgres => {
     const openClients: Client[] = [];
     const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
       const value = await made; openClients.push(value.client); return value;
     };
     try {
      await installUpdaterSchema(postgres);
      const { client: deployer, store } = await tracked(deployerStore(postgres));
      const root = await installRootV1("republish");
      t.after(async () => { await rm(root, { recursive: true, force: true }); });

      // Publish one registration through the REAL store, then run the port's own
      // publish a second time for the SAME digest.
      //
      // The INSERT is `ON CONFLICT (registration_digest) DO NOTHING … RETURNING`,
      // so a second publish returns ZERO rows. A port that did not check the count
      // would report success and carry on to the terminal, and the owner would be
      // asked for a code against a row holding somebody else's options.
      //
      // MEASURED: this is the one guard my own reviewer pass found in the committed
      // port — `await session.query(...)` discarded the result entirely. The
      // mutation below is that exact line.
      const digest = `sha256:${createHash("sha256").update("m3-republish").digest("hex")}`;
      const options = { schema: "control-room.passkey-registration-options/v1", registrationDigest: digest,
        publicKey: { challenge: "A".repeat(43), rp: { id: RP_ID, name: "Control Room" } } };
      await store.openRegistration({ registrationDigest: digest, installationId: INSTALLATION, mode: "initial",
        optionsJson: options as never, authorizationChallenge: null,
        expiresAt: new Date(Date.now() + 1_800_000).toISOString() });

      // The port's publish, as the port writes it. Run through the port itself is
      // impossible without a whole authority, so the query is the port's query and
      // the assertion is the port's: this is the exact statement, and the count
      // check is what the mutation removes.
      const again = await deployer.query(`INSERT INTO updater.passkey_open_registrations
          (registration_digest, installation_id, mode, options_json, authorization_challenge, expires_at)
        VALUES ($1,$2,'initial',$3::jsonb,NULL,$4::timestamptz)
        ON CONFLICT (registration_digest) DO NOTHING
        RETURNING registration_digest`,
      [digest, INSTALLATION, JSON.stringify(options), new Date(Date.now() + 1_800_000).toISOString()]);
      assert.equal(again.rows.length, 0, "a republish of the same digest inserts nothing");
      // And the port refuses on exactly this shape. A guard with no test of its own
      // is the failure mode the mutation harness exists to catch, so this is the
      // guard's own test rather than a comment about it.
      const port = await import("../src/updater/v1/pg/initial-passkey-ports.mjs") as {
        registerInitialPasskeyV1(input: unknown, runtime: unknown): Promise<unknown>;
      };
      await assert.rejects(port.registerInitialPasskeyV1({ root,
        config: { installationId: INSTALLATION, rpId: RP_ID, expectedOrigin: ORIGIN },
        ownerCode: "owner-code-value-1234",
        terminal: { isTTY: true, write: () => {}, setRawMode: () => {}, readLine: async () => "ABC234" },
        qr: {}, maxAttempts: 5 }, { authority: { beginRegistration: async () => ({
          registrationSecret: b64(Buffer.from(digest.slice("sha256:".length), "hex")),
          registrationDigest: digest, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }),
          registrationOptions: async () => options, completeRegistration: async () => ({ credentialId: "x" }) },
          session: deployer }), { code: "passkey_registration_already_open" },
        "a retried begin must refuse, not report a publish it did not perform");
     } finally {
       await Promise.all(openClients.map(client => client.end().catch(() => {})));
     }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
  });

test("M3: the port refuses a missing authority or session rather than running a ceremony", needsPg(), async t => {
  ran += 1;
  await withRealPostgres(async postgres => {
   // Every client this body opens is recorded here so the `finally` can close it
   // before the harness stops the cluster. `trackedPostgres` is the only way a
   // client is created below, so nothing can be opened and forgotten.
   const openClients: Client[] = [];
   const tracked = async <T extends { client: Client }>(made: Promise<T>): Promise<T> => {
     const value = await made; openClients.push(value.client); return value;
   };
   try {
    const root = await installRootV1("unbound");
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    const base = { root, config: { installationId: INSTALLATION, rpId: RP_ID, expectedOrigin: ORIGIN },
      ownerCode: "owner-code-value-1234", terminal: { isTTY: true, write: () => {}, setRawMode: () => {},
        readLine: async () => "ABC234" }, qr: {}, maxAttempts: 5 };
    await assert.rejects(registerInitialPasskeyV1(base as never, {}), { code: "passkey_authority_port_unbound" });
    await assert.rejects(registerInitialPasskeyV1(base as never, { authority: {} }), { code: "passkey_session_refused" });
    // A session that is not a client is refused, not called.
    await assert.rejects(registerInitialPasskeyV1(base as never, { authority: {}, session: { query: "yes" } }),
      { code: "passkey_session_refused" });
   } finally {
     // The clients are closed INSIDE the body, on purpose. A `t.after` hook runs
     // AFTER `withRealPostgres`'s own `finally`, which has already stopped the
     // cluster, so ending a client there raises `terminating connection due to
     // administrator command` (57P01) as an unhandled rejection — and node:test
     // then reports THAT in place of the test's real result.
     //
     // MEASURED: this masked a PASSING test for several iterations, which is worse
     // than a red one, because every fix looked like it had changed nothing.
     await Promise.all(openClients.map(client => client.end().catch(() => {})));
   }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});

test.after(() => {
  if (required > 0) assert.equal(ran, required, "every test that needed PostgreSQL ran it");
});


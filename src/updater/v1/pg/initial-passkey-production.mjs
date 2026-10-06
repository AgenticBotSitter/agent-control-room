// The install-night Face ID port: §5.4's deployer session and passkey authority,
// built around M3's port (`initial-passkey-ports.mjs`).
//
// It is its own module (atk-fa F2) so that BOTH callers hold the same function: the
// native port object (`cli/control-room-native-ports.mjs`, which the installer runs
// from the git-archive copy) re-exports it, and stage one (`install/stage-one-ports.mjs`)
// hands it out. Stage one is what the installer CALLS, and stage one is loaded from
// the confirmed, digest-verified fixed bundle, where esbuild has inlined `pg`,
// `@simplewebauthn/server` and the passkey modules below. The archive copy has no
// `node_modules`, so its own copy of this function could never load `pg`: every
// install night stopped the Face ID step with `passkey_registration_failed`.
//
// The heavy imports stay DYNAMIC with literal specifiers: an unbundled import of
// this module (the archive's native ports) must still load without `node_modules`,
// and esbuild still bundles a literal dynamic import.
import { isAbsolute, resolve } from "node:path";
import { readFileNoFollowV1 } from "../fs-safety.mjs";
import { registerInitialPasskeyV1 as initialPasskeyV1 } from "./initial-passkey-ports.mjs";

const passkeyRefuse = code => { throw Object.assign(new Error(code), { code }); };

/**
 * `registerInitialPasskey` as the installer calls it: §5.4's session and authority,
 * built here, around M3's port.
 *
 *   - the SESSION is a `pg.Client` over `updater.json`'s socket as
 *     `control_room_deployer`. The installer is root, and the peer map's
 *     `cr root control_room_deployer` line is what lets it in with no password;
 *     `PasskeyStoreV1.initialize()` then asserts the role, and a session that is
 *     not the deployer stops here with `updater_store_role_refused`.
 *     `updater.json` is read by the updater's own loader, so the socket, the
 *     database and the login are the values the updater daemon uses, checked by
 *     the same parser;
 *   - the AUTHORITY is `PasskeyAuthorityV1` over `PasskeyStoreV1` on that
 *     session, with no fixed config, so it reads `Protected/config/host.json`
 *     exactly as the daemon's does;
 *   - the port's `config` is that SAME `host.json`. Stage one hands the installer
 *     `{ rpId }` and nothing else, and the port needs `installationId` for the
 *     open-registration row the web reads; without it every attempt refused
 *     `passkey_registration_result_refused`. A `host.json` whose RP ID is not the
 *     one stage one printed the QR for is refused rather than used.
 *
 * Everything is imported on first use: `pg` and `@simplewebauthn/server` are not
 * in an archive without `node_modules`, and this module must still load there.
 *
 * `runtime.databasePort` exists for the real-PostgreSQL lane alone, which cannot
 * bind the release's 5432; nothing on the install path passes a runtime.
 */
export async function registerInitialPasskeyProductionV1(input, runtime = {}) {
  const root = input?.root;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || !runtime || typeof runtime !== "object" || Object.keys(runtime).some(key => key !== "databasePort")
    || runtime.databasePort !== undefined && (!Number.isSafeInteger(runtime.databasePort)
      || runtime.databasePort < 1 || runtime.databasePort > 65535)) passkeyRefuse("passkey_registration_input_refused");
  const [{ loadUpdaterConfigurationV1 }, { PasskeyAuthorityV1, parsePasskeyConfigV1 }, { PasskeyStoreV1 }, pg] =
    await Promise.all([import("../updater.mjs"), import("../passkey.mjs"), import("../passkey-store.mjs"), import("pg")]);
  const { database } = await loadUpdaterConfigurationV1(root);
  let config;
  try { config = parsePasskeyConfigV1(JSON.parse(await readFileNoFollowV1(root, "Protected/config/host.json",
    { maxBytes: 16_384 }))); }
  catch { passkeyRefuse("updater_passkey_config_refused"); }
  if (input.config.rpId !== undefined && input.config.rpId !== config.rpId) passkeyRefuse("updater_passkey_config_refused");
  // PRACTICE MODE ONLY. `--authenticator software` reaches here only through the
  // installer's rehearsal gate, and the phone is built — and gated again, on the
  // root, the RP ID and the web port — BEFORE any database connection, so a real
  // install that somehow carried the flag stops here with nothing written. The web
  // origin is the installed web host's own loopback origin from
  // `local-owner-session.json`, the file the web reads at start.
  let softwareAuthenticator;
  if (input.authenticator !== undefined) {
    if (input.authenticator !== "software") passkeyRefuse("passkey_registration_input_refused");
    let webOrigin;
    try { webOrigin = JSON.parse(await readFileNoFollowV1(root, "Protected/config/local-owner-session.json",
      { maxBytes: 16_384 })).origin; }
    catch { passkeyRefuse("rehearsal_authenticator_refused"); }
    const { createRehearsalPhoneV1 } = await import("../install/rehearsal-authenticator.mjs");
    softwareAuthenticator = createRehearsalPhoneV1({ root, rpId: config.rpId, expectedOrigin: config.expectedOrigin,
      webOrigin, ownerCode: input.ownerCode });
  }
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({ host: database.host, port: runtime.databasePort ?? database.port,
    database: database.name, user: database.user, ssl: false, connectionTimeoutMillis: 30_000,
    application_name: "control-room-install-passkey" });
  try { await client.connect(); }
  catch (error) {
    await client.end().catch(() => {});
    passkeyRefuse(`passkey_deployer_session_refused:${String(error?.code ?? "unknown").slice(0, 40)}`);
  }
  try {
    const store = new PasskeyStoreV1(client);
    await store.initialize();
    const authority = new PasskeyAuthorityV1({ root, store });
    return await initialPasskeyV1({ ...input, config }, { authority, session: client,
      ...(softwareAuthenticator ? { softwareAuthenticator } : {}) });
  } finally { await client.end().catch(() => {}); }
}

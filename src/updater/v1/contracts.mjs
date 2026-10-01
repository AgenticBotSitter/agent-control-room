/** Shared, bounded wire and file formats for updater item 8. */

export const SAFE_ID_V1 = /^[A-Za-z0-9._-]{1,80}$/u;
export const SAFE_STEP_V1 = /^[a-z][a-z0-9_]{1,63}$/u;

export const PHONE_FALLBACK_VERBS_V1 = Object.freeze(new Set([
  "pause", "resume", "stop", "backup-now", "check-and-continue", "repair-serve", "rollback",
]));
export const PASSKEY_CONTROL_VERBS_V1 = Object.freeze(new Set([
  "passkey-add-begin", "passkey-add-complete", "passkey-list", "passkey-revoke",
]));

export const SUDO_ONLY_VERBS_V1 = Object.freeze(new Set([
  "confirm", "install", "owner-code", "passkey", "run-without-profiles", "serve-accept",
  "uninstall-fresh", "upgrade-attended",
]));

export function updaterRefuseV1(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function assertSafeIdV1(value, code = "updater_id_refused") {
  if (typeof value !== "string" || !SAFE_ID_V1.test(value)) throw updaterRefuseV1(code);
  return value;
}

export function assertPlainObjectV1(value, code = "updater_object_refused") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw updaterRefuseV1(code);
  return value;
}

export function parseSelfUpdateFlagV1(text) {
  if (text === "Off\n" || text === "Off") return "Off";
  if (text === "On\n" || text === "On") return "On";
  throw updaterRefuseV1("updater_self_update_flag_refused");
}

export function parseKnownGoodV1(value) {
  const object = assertPlainObjectV1(value, "updater_known_good_refused");
  if (object.schema !== "control-room.known-good/v1" || !Array.isArray(object.pairs)
      || object.pairs.length < 1 || object.pairs.length > 3) throw updaterRefuseV1("updater_known_good_refused");
  if (object.count !== object.pairs.length)
    throw updaterRefuseV1("updater_known_good_refused");
  const pairs = object.pairs.map(pair => {
    const item = assertPlainObjectV1(pair, "updater_known_good_refused");
    return Object.freeze({
      releaseId: assertSafeIdV1(item.releaseId, "updater_known_good_refused"),
      pgDataId: assertSafeIdV1(item.pgDataId, "updater_known_good_refused"),
      schemaDigest: typeof item.schemaDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(item.schemaDigest)
        ? item.schemaDigest : (() => { throw updaterRefuseV1("updater_known_good_refused"); })(),
    });
  });
  return Object.freeze({ schema: object.schema, pairs: Object.freeze(pairs) });
}

export function parseControlRequestV1(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 8192) throw updaterRefuseV1("updater_request_too_large");
  let value;
  try { value = JSON.parse(line); } catch { throw updaterRefuseV1("updater_request_json_refused"); }
  const object = assertPlainObjectV1(value, "updater_request_refused");
  const allowed = new Set(["schema", "requestId", "verb", "arguments"]);
  if (Object.keys(object).some(key => !allowed.has(key)) || object.schema !== "control-room.updater-control/v1")
    throw updaterRefuseV1("updater_request_refused");
  assertSafeIdV1(object.requestId, "updater_request_refused");
  if (!PHONE_FALLBACK_VERBS_V1.has(object.verb) && !PASSKEY_CONTROL_VERBS_V1.has(object.verb)
      || !Array.isArray(object.arguments)
      || object.arguments.length > 8 || object.arguments.some(argument => typeof argument !== "string"
        || Buffer.byteLength(argument) > 256)) throw updaterRefuseV1("updater_request_refused");
  return Object.freeze({ schema: object.schema, requestId: object.requestId, verb: object.verb,
    arguments: Object.freeze([...object.arguments]) });
}

export function publicStatusV1(input = {}) {
  const state = typeof input.state === "string" ? input.state : "idle";
  const allowedStates = new Set(["idle", "watching", "building", "awaiting_approval", "running", "rolled_back",
    "uncertain", "attended_upgrade_required", "paused", "stopped", "needs_attention"]);
  if (!allowedStates.has(state)) throw updaterRefuseV1("updater_status_state_refused");
  const releaseId = input.releaseId === null || input.releaseId === undefined ? null
    : assertSafeIdV1(input.releaseId, "updater_status_release_refused");
  const lastHealthAt = input.lastHealthAt === null || input.lastHealthAt === undefined ? null : String(input.lastHealthAt);
  if (lastHealthAt !== null && !Number.isFinite(Date.parse(lastHealthAt)))
    throw updaterRefuseV1("updater_status_health_refused");
  let backup;
  if (input.backup !== undefined) {
    if (!["ok", "failed", "missing"].includes(input.backup))
      throw updaterRefuseV1("updater_status_backup_refused");
    backup = input.backup;
  }
  return Object.freeze({ schema: "control-room.updater-status/v1", state, releaseId, lastHealthAt,
    needsYou: input.needsYou === true, updaterRestartsLastHour: Number.isInteger(input.updaterRestartsLastHour)
      && input.updaterRestartsLastHour >= 0 && input.updaterRestartsLastHour <= 3 ? input.updaterRestartsLastHour : 0,
    selfUpdate: input.selfUpdate === "On" ? "On" : "Off", ...(backup === undefined ? {} : { backup }) });
}

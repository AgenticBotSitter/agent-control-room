/** Shared, bounded wire and file formats for updater item 8. */
import nextActionsV1 from "./policy/next-actions.json" with { type: "json" };
export const NEXT_ACTIONS_V1 = Object.freeze(nextActionsV1);

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

/** The switch file is three bytes of text written by the installer. Anything else — torn by a
 * crash, truncated by a full disk, hand-edited, or padded with a byte order mark or a
 * non-breaking space — is a switch we cannot read, and an unreadable switch must mean OFF.
 *
 * Exactly `On` / `Off`, optionally followed by ONE newline, and nothing else. The older version
 * trimmed and compared, so `"﻿On\n"`, `" On \r\n"` and a no-break-space-padded `On` were
 * accepted as On by the runtime while the installer accepted only the exact bytes: two readers,
 * two answers, and the looser one was the one that could start an update.
 */
export function parseSelfUpdateFlagV1(text) {
  if (typeof text !== "string") throw updaterRefuseV1("updater_self_update_flag_refused");
  const value = text.replace(/\n$/u, "");
  if (value === "Off") return "Off";
  if (value === "On") return "On";
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

/** The fixed owner-facing sentences for a durable run outcome (R7U-01).
 *
 * ONE TABLE, IN ONE PLACE, and every entry is a constant. The reason an update
 * failed is a CODE the runner chose, never prose from a failing step and never
 * anything a caller composed — the durable row carries the code and this table
 * turns it into the words the owner reads, which is the same division of labour
 * `updater.owner_review` uses (fixed text written by SQL, facts read by a
 * column-scoped grant).
 *
 * It is keyed by `detail.code` and NOT by the state, because the state's own
 * runner message is not enough to be useful: "Automatic recovery needs owner
 * attention" tells the owner nothing about what to do next, which is the part
 * that matters when this card is the only place the failure is ever mentioned.
 * An unknown code falls back to the state sentence, so a code added later cannot
 * make the display refuse — but it also cannot invent wording.
 */
export const UPDATER_RUN_REASON_V1 = Object.freeze({
  updater_rollback_chain_exhausted:
    "Automatic recovery could not finish. Nothing changed on its own; Control Room needs you.",
  updater_rollback_failed:
    "Automatic recovery could not put the previous version back. Control Room needs you.",
  updater_measurement_inconsistent:
    "Control Room could not confirm what is installed, so it stopped and needs you.",
  updater_self_update_off:
    "The update was refused before the switch, because self-update was Off. Nothing changed.",
  updater_owner_stop:
    "The update was refused before the switch, because you stopped it. Nothing changed.",
  updater_rescue_marker:
    "A rescue happened and Control Room cannot tell what is installed. Check and continue.",
  updater_journal_invalid:
    "The updater's record of the update is damaged, so it stopped. Check and continue.",
  updater_runner_error:
    "The updater hit an error and will retry from its durable step. Check and continue if it keeps happening.",
  updater_step_failed:
    "An update step failed, so Control Room is recovering automatically.",
  updater_health_failed:
    "Control Room could not confirm the new version was healthy, so it is recovering automatically.",
  updater_resumed_failure:
    "Control Room is finishing the recovery it started earlier.",
});

/** The state-level fallback, for an outcome whose code this tree has no
 * sentence for. Plain words, one obvious next action, and never a path, a
 * newline or a control byte — this reaches the owner's phone. */
export const UPDATER_RUN_STATE_REASON_V1 = Object.freeze({
  needs_attention: "An update could not finish cleanly. Control Room needs you.",
  // Lead decision 2: a runner `error` is published DURABLY into the attention
  // row, so it needs a sentence of its own. It is deliberately NOT folded into
  // `needs_attention` in this table: the owner is told the updater hit an error
  // and will retry, which is a different promise from "an update could not finish
  // cleanly" — that one implies the install is in a state somebody must settle.
  error: "The updater hit an error and will retry from its durable step. Check and continue if it keeps happening.",
  uncertain: "Control Room cannot tell whether the last update finished. Check and continue.",
  attended_upgrade_required: "An update needs you to finish it on the Mac.",
  refused: "The update was refused before the switch. Nothing was changed.",
  rolled_back: "The previous known-good version is back.",
});

/** The one sentence the owner reads for a durable run outcome, or null when the
 * outcome is not one that needs the owner.
 *
 * A caller-supplied code never reaches the screen: a code is only ever a KEY
 * into these tables, so a row carrying a code nobody here knows renders as its
 * state's sentence rather than as the code itself.
 *
 * @param {{state: string, code?: string|null}|null|undefined} outcome */
export function updaterRunReasonV1(outcome) {
  const attention = updaterRunAttentionV1(outcome);
  return attention === null ? null : attention.reason;
}

/** The same answer, split into the two fields the status file actually carries.
 *
 * `nextAction` is an ALLOWLISTED KEY and `reason` is the sentence that explains
 * THIS outcome, and returning them together is what stops a call site from
 * having to remember that they are different kinds of value. A caller that put
 * the sentence in `nextAction` is refused by `publicStatusV1`; a caller that put
 * a key in `reason` is refused the same way.
 *
 * @param {{state: string, code?: string|null}|null|undefined} outcome
 * @returns {null|{nextAction: string, reason: string}} */
export function updaterRunAttentionV1(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const state = outcome.state, code = outcome.code;
  if (typeof state !== "string" || !Object.hasOwn(UPDATER_RUN_STATE_REASON_V1, state)) return null;
  const reason = typeof code === "string" && Object.hasOwn(UPDATER_RUN_REASON_V1, code)
    ? UPDATER_RUN_REASON_V1[code] : UPDATER_RUN_STATE_REASON_V1[state];
  const nextAction = UPDATER_RUN_NEXT_ACTION_V1[state];
  // A state with a sentence but no key is a refusal rather than a partial answer:
  // publishing the reason alone would be the merge's exact failure, one layer up.
  if (typeof nextAction !== "string") return null;
  return Object.freeze({ nextAction, reason });
}

/** The action key for an outstanding outcome, per state. Kept beside the
 * sentences and validated against the same `policy/next-actions.json` allowlist
 * `publicStatusV1` uses, so the mapping is one table rather than two that can
 * disagree. */
export const UPDATER_RUN_NEXT_ACTION_V1 = Object.freeze({
  needs_attention: "review_recovery",
  uncertain: "check_and_continue",
  attended_upgrade_required: "upgrade_on_mac",
  error: "check_and_continue",
  refused: "review_refused_update",
  rolled_back: "review_rolled_back_update",
});

/** Every sentence this contract will accept, for the allowlist check in
 * `publicStatusV1`. Built from the two tables above rather than restated, so a
 * word added to a table is accepted by construction and a word removed from one
 * is refused by construction — there is no third list to forget. */
const OWNER_SENTENCES_V1 = new Set([...Object.values(UPDATER_RUN_REASON_V1), ...Object.values(UPDATER_RUN_STATE_REASON_V1)]);

export function publicStatusV1(value) {
  const input = assertPlainObjectV1(value ?? {}, "updater_status_refused");
  const state = typeof input.state === "string" ? input.state : "idle";
  const allowedStates = new Set(["idle", "watching", "building", "awaiting_approval", "running", "rolled_back",
    "uncertain", "attended_upgrade_required", "paused", "stopped", "needs_attention", "refused"]);
  if (!allowedStates.has(state)) throw updaterRefuseV1("updater_status_state_refused");
  const releaseId = input.releaseId === null || input.releaseId === undefined ? null
    : assertSafeIdV1(input.releaseId, "updater_status_release_refused");
  const lastHealthAt = input.lastHealthAt === null || input.lastHealthAt === undefined ? null : typeof input.lastHealthAt === "string" ? input.lastHealthAt
      : (() => { throw updaterRefuseV1("updater_status_health_refused"); })();
  if (lastHealthAt !== null && !Number.isFinite(Date.parse(lastHealthAt)))
    throw updaterRefuseV1("updater_status_health_refused");
  // R7U-02 (cook/r7ufix): `nextAction` is an ALLOWLISTED KEY, never prose. It
  // is the machine-actionable half of the card and it is drawn from
  // `policy/next-actions.json`, so what the owner reads for a given action is a
  // reviewed constant rather than something composed at a call site. Omitting it
  // derives the key from the STATE, which is what makes the ordinary case free.
  const nextAction = input.nextAction === undefined ? ({ uncertain: "check_and_continue", needs_attention: "review_recovery",
    attended_upgrade_required: "upgrade_on_mac", refused: "review_refused_update",
    rolled_back: "review_rolled_back_update" }[state] ?? null) : input.nextAction;
  if (nextAction !== null && (typeof nextAction !== "string" || !Object.hasOwn(NEXT_ACTIONS_V1, nextAction)))
    throw updaterRefuseV1("updater_status_next_action_refused");
  // R7U-01: `reason` is the OTHER half, and it is a DIFFERENT FIELD rather than a
  // second meaning for `nextAction`. The two answer different questions and the
  // merge is what proved it: `nextAction` had come to mean both "which reviewed
  // action is this" and "the sentence that explains this specific failure", and
  // one field cannot hold an allowlisted key and free text without one of them
  // becoming the channel.
  //
  // SO IT IS AN ALLOWLIST AND NOT A LENGTH CHECK. The value must be one of the
  // fixed constants in the two tables above, which is what stops this field from
  // being a place a caller composes wording: a row carrying a code nobody here
  // knows renders as its STATE's sentence, and a caller that passes anything else
  // is refused rather than displayed. The printable-line bound is kept as well,
  // because it is the reason those constants are written the way they are, and a
  // second wall for a future edit to the table is cheap.
  const reason = input.reason === null || input.reason === undefined ? null : input.reason;
  if (reason !== null && (typeof reason !== "string"
      || reason.length === 0 || reason.length > 200
      || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(reason)
      || !OWNER_SENTENCES_V1.has(reason)))
    throw updaterRefuseV1("updater_status_reason_refused");
  return Object.freeze({ schema: "control-room.updater-status/v1", state, releaseId, lastHealthAt,
    ...(nextAction === null ? {} : { nextAction }), ...(reason === null ? {} : { reason }),
    needsYou: input.needsYou === true, updaterRestartsLastHour: Number.isInteger(input.updaterRestartsLastHour)
      && input.updaterRestartsLastHour >= 0 && input.updaterRestartsLastHour <= 3 ? input.updaterRestartsLastHour : 0,
    selfUpdate: input.selfUpdate === "On" ? "On" : "Off" });
}

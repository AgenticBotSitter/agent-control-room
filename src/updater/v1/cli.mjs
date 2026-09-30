import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { PHONE_FALLBACK_VERBS_V1, SUDO_ONLY_VERBS_V1, publicStatusV1, updaterRefuseV1 } from "./contracts.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { sendControlRequestV1 } from "./control-socket.mjs";
import { canonicalJsonV1 } from "./canonical-json.mjs";

const WORDS_V1 = Object.freeze(("amber anchor apple arch arrow atlas badge bamboo beacon birch blue bolt brave brick brook "
  + "cabin cedar circle cloud coral crane dawn delta dune ember fern field flame flint forest frost garden glass "
  + "gold grove harbor hazel hill iris ivory jade lake leaf light linen maple meadow mint moon north oak ocean olive "
  + "onyx pine plum quartz rain reed river robin sage silver sky slate snow south star stone sun tide trail vale west").split(" "));

export { canonicalJsonV1 } from "./canonical-json.mjs";

export function confirmationWordsV1(planDigest) {
  if (typeof planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(planDigest))
    throw updaterRefuseV1("updater_plan_digest_refused");
  const bytes = Buffer.from(planDigest.slice(7), "hex");
  return [0, 1, 2, 3].map(index => WORDS_V1[bytes[index] & 63]);
}

function requireRootV1(context, verb) {
  if (context.getuid() !== 0) throw updaterRefuseV1(`updater_${verb.replaceAll("-", "_")}_needs_root`);
}

function announceSudoV1(context, action) {
  context.stdout(`Control Room is asking for your Mac password to: ${action}.\n`);
}

async function readComparisonCodeV1() {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw updaterRefuseV1("updater_passkey_code_terminal_required");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return await terminal.question("Type the 6-character code shown on the registration page: "); }
  finally { terminal.close(); }
}

async function confirmV1(root, words, context) {
  requireRootV1(context, "confirm");
  announceSudoV1(context, "confirm this updater plan");
  if (words.length !== 4) throw updaterRefuseV1("updater_confirm_words_refused");
  const index = JSON.parse(await readFileNoFollowV1(root, "updater-state/open-confirmation.json", { maxBytes: 4096 }));
  if (!index || typeof index.planId !== "string") throw updaterRefuseV1("updater_confirm_plan_refused");
  const plan = JSON.parse(await readFileNoFollowV1(root, `updater-state/plans/${index.planId}.json`, { maxBytes: 65536 }));
  if (!plan || plan.planId !== index.planId || !["updater", "setting"].includes(plan.kind))
    throw updaterRefuseV1("updater_confirm_plan_refused");
  const canonical = canonicalJsonV1(plan);
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  if (digest !== index.planDigest) throw updaterRefuseV1("updater_confirm_plan_digest_mismatch");
  const expected = confirmationWordsV1(digest);
  context.stdout(`Control Room updater plan ${plan.planId}\nKind: ${plan.kind}\nFrom: ${plan.from?.releaseId ?? "unknown"}\n`
    + `To: ${plan.artifact?.releaseId ?? "settings only"}\nChanges database: ${plan.updaterDerived?.changesDatabase === true ? "yes" : "no"}\n`
    + `Changes updater: ${plan.updaterDerived?.changesUpdater === true ? "yes" : "no"}\nConfirmation: ${expected.join(" ")}\n`);
  if (words.join(" ") !== expected.join(" ")) throw updaterRefuseV1("updater_confirm_words_refused");
  await atomicWriteNoFollowV1(root, `updater-state/confirmations/${plan.planId}.json`, `${JSON.stringify({
    schema: "control-room.mac-confirmation/v1", planId: plan.planId, planDigest: digest, confirmed: true,
    confirmedAt: context.now().toISOString(),
  })}\n`);
  return 0;
}

export async function runUpdaterCliV1(argv, options = {}) {
  const root = options.root ?? "/Library/Application Support/Control Room";
  const context = { getuid: options.getuid ?? (() => process.getuid?.() ?? -1), now: options.now ?? (() => new Date()),
    stdout: options.stdout ?? (text => process.stdout.write(text)),
    stderr: options.stderr ?? (text => process.stderr.write(text)),
    send: options.send ?? sendControlRequestV1,
    readComparisonCode: options.readComparisonCode ?? readComparisonCodeV1 };
  const [verb, ...args] = argv;
  if (verb === "status") {
    const status = publicStatusV1(JSON.parse(await readFileNoFollowV1(root, "status/status.json", { maxBytes: 8192 })));
    context.stdout(`${JSON.stringify(status, null, 2)}\n`); return 0;
  }
  if (verb === "confirm") return confirmV1(root, args, context);
  if (verb === "passkey") {
    requireRootV1(context, "passkey");
    const authority = options.passkeyAuthority;
    const [action, value, ...extra] = args;
    if (extra.length || !["add", "list", "revoke"].includes(action))
      throw updaterRefuseV1("updater_passkey_arguments_refused");
    announceSudoV1(context, action === "add" ? "start adding a passkey"
      : action === "list" ? "list passkeys" : "revoke a passkey");
    if (action === "add") {
      if (value !== undefined) throw updaterRefuseV1("updater_passkey_arguments_refused");
      const registration = authority ? await authority.beginRegistration({ mode: "add" })
        : await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
          requestId: `cli-${process.pid}-${Date.now()}`, verb: "passkey-add-begin", arguments: [] });
      if (!registration || typeof registration.registrationSecret !== "string"
          || !/^[A-Za-z0-9_-]{43}$/u.test(registration.registrationSecret)
          || typeof registration.expectedOrigin !== "string" && typeof registration.config?.expectedOrigin !== "string")
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      const expectedOrigin = registration.expectedOrigin ?? registration.config.expectedOrigin;
      context.stdout(`${expectedOrigin}/setup#reg=${registration.registrationSecret}&mode=add\n`);
      context.stdout("The registration expires in 30 minutes. The new passkey needs approval from an active passkey, or it remains inactive for 24 hours.\n");
      const typedCode = (await context.readComparisonCode()).trim().toUpperCase();
      const result = authority ? await authority.completeRegistration({ registrationSecret: registration.registrationSecret,
        typedCode }) : await context.send(join(root, "updater-state/control.sock"), {
          schema: "control-room.updater-control/v1", requestId: `cli-${process.pid}-${Date.now()}`,
          verb: "passkey-add-complete", arguments: [registration.registrationSecret, typedCode] }, { timeoutMs: 15_000 });
      if (!result || result.coolingOffUntil !== null && typeof result.coolingOffUntil !== "string")
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      if (result.coolingOffUntil && result.coolingOffNoticesEnqueued !== true)
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      context.stdout(result.coolingOffUntil
        ? `Passkey added. It is inactive until ${result.coolingOffUntil}. Cooling-off warnings were queued.\n`
        : "Passkey added and active.\n");
      return 0;
    }
    if (action === "list") {
      if (value !== undefined) throw updaterRefuseV1("updater_passkey_arguments_refused");
      const rows = authority ? await authority.listPasskeys()
        : await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
          requestId: `cli-${process.pid}-${Date.now()}`, verb: "passkey-list", arguments: [] });
      if (!Array.isArray(rows) || rows.length > 32) throw updaterRefuseV1("updater_passkey_control_reply_refused");
      for (const row of rows) context.stdout(`${row.number}. ${row.revokedAt ? "revoked" : row.coolingOffUntil
        && Date.parse(row.coolingOffUntil) > context.now().getTime() ? `inactive until ${row.coolingOffUntil}` : "active"}`
        + `; created ${row.createdAt}; id ${row.credentialId}\n`);
      return 0;
    }
    if (!/^[1-9][0-9]{0,2}$/u.test(value ?? "")) throw updaterRefuseV1("updater_passkey_number_refused");
    const revoked = authority ? await authority.revokePasskey(Number(value))
      : await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
        requestId: `cli-${process.pid}-${Date.now()}`, verb: "passkey-revoke", arguments: [value] });
    if (!revoked || revoked.number !== Number(value)) throw updaterRefuseV1("updater_passkey_control_reply_refused");
    context.stdout(`Passkey ${revoked.number} was revoked.\n`); return 0;
  }
  if (PHONE_FALLBACK_VERBS_V1.has(verb)) {
    requireRootV1(context, verb);
    announceSudoV1(context, `send the ${verb} fallback request`);
    await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
      requestId: `cli-${process.pid}-${Date.now()}`, verb, arguments: args });
    context.stdout("The updater accepted the owner fallback request.\n"); return 0;
  }
  if (SUDO_ONLY_VERBS_V1.has(verb)) {
    requireRootV1(context, verb);
    announceSudoV1(context, `perform ${verb}`);
    throw updaterRefuseV1("updater_cli_port_not_implemented");
  }
  context.stderr("Usage: control-room status | confirm <word word word word> | passkey add|list|revoke <number> | pause | resume | stop | backup-now | check-and-continue | repair-serve | rollback\n");
  return 64;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) runUpdaterCliV1(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${typeof error?.code === "string" ? error.code : "updater_cli_failed"}\n`); process.exitCode = 1;
});

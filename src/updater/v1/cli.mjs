import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PHONE_FALLBACK_VERBS_V1, SUDO_ONLY_VERBS_V1, publicStatusV1, updaterRefuseV1 } from "./contracts.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { sendControlRequestV1 } from "./control-socket.mjs";

const WORDS_V1 = Object.freeze(("amber anchor apple arch arrow atlas badge bamboo beacon birch blue bolt brave brick brook "
  + "cabin cedar circle cloud coral crane dawn delta dune ember fern field flame flint forest frost garden glass "
  + "gold grove harbor hazel hill iris ivory jade lake leaf light linen maple meadow mint moon north oak ocean olive "
  + "onyx pine plum quartz rain reed river robin sage silver sky slate snow south star stone sun tide trail vale west").split(" "));

export function canonicalJsonV1(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw updaterRefuseV1("updater_plan_json_refused");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => {
    const child = value[key];
    if (child === undefined || ["function", "symbol", "bigint"].includes(typeof child))
      throw updaterRefuseV1("updater_plan_json_refused");
    return `${JSON.stringify(key)}:${canonicalJsonV1(child)}`;
  }).join(",")}}`;
  throw updaterRefuseV1("updater_plan_json_refused");
}

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
    send: options.send ?? sendControlRequestV1 };
  const [verb, ...args] = argv;
  if (verb === "status") {
    const status = publicStatusV1(JSON.parse(await readFileNoFollowV1(root, "status/status.json", { maxBytes: 8192 })));
    context.stdout(`${JSON.stringify(status, null, 2)}\n`); return 0;
  }
  if (verb === "confirm") return confirmV1(root, args, context);
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
  context.stderr("Usage: control-room status | confirm <word word word word> | pause | resume | stop | backup-now | check-and-continue | repair-serve | rollback\n");
  return 64;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) runUpdaterCliV1(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${typeof error?.code === "string" ? error.code : "updater_cli_failed"}\n`); process.exitCode = 1;
});

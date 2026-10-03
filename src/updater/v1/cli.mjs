#!/usr/bin/env node
// The union of both import blocks: ours parses installer flags
// (`isAbsolute`, `resolve`, `pathToFileURL`), `cook/v1` brought the entry
// guard and the public status read plus the readline it needs
// (`createInterface`, `publicStatusV1`). Neither is a variant of the
// other, so taking either block alone would drop a feature.
import { isMainModuleV1 } from "../../installer/shared/is-main-module.mjs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { PHONE_FALLBACK_VERBS_V1, SUDO_ONLY_VERBS_V1, publicStatusV1, updaterRefuseV1 } from "./contracts.mjs";
import { atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { sendControlRequestV1 } from "./control-socket.mjs";
import { canonicalJsonV1 } from "./canonical-json.mjs";
import {
  DEFAULT_CONTROL_ROOM_ROOT_V1, DEFAULT_CONTROL_ROOM_WEB_PORT_V1, installControlRoomV1, statusControlRoomV1,
  uninstallFreshControlRoomV1,
} from "./install/installer.mjs";
import { readCodeV1 } from "./terminal/read-code.mjs";

const WORDS_V1 = Object.freeze(("amber anchor apple arch arrow atlas badge bamboo beacon birch blue bolt brave brick brook "
  + "cabin cedar circle cloud coral crane dawn delta dune ember fern field flame flint forest frost garden glass "
  + "gold grove harbor hazel hill iris ivory jade lake leaf light linen maple meadow mint moon north oak ocean olive "
  + "onyx pine plum quartz rain reed river robin sage silver sky").split(" "));

export const CONTROL_ROOM_INSTALLER_CAPABILITIES_V1 = Object.freeze({
  schema: "control-room.installer-capabilities/v1",
  version: 1,
  rehearsal: Object.freeze({
    config: "control-room.e2e2-rehearsal-config/v1",
    freshDatabase: true,
    softwareAuthenticator: "es256-fixed-v1",
    evidence: "control-room.e2e2-evidence/v1",
    ownerReadableEvidence: true,
    tailscale: Object.freeze({
      mutationAllowed: false,
      capture: "skipped (rehearsal)",
      activate: "skipped (rehearsal)",
      restore: "skipped (rehearsal)",
    }),
  }),
});

export { canonicalJsonV1 } from "./canonical-json.mjs";

export function confirmationWordsV1(planDigest) {
  if (typeof planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(planDigest))
    throw updaterRefuseV1("updater_plan_digest_refused");
  const bytes = Buffer.from(planDigest.slice(7), "hex");
  return [0, 1, 2, 3, 4, 5].map(index => WORDS_V1[bytes[index] & 63]);
}

// THE COUNT, SPELLED. It lives beside `WORDS_V1` rather than inside the retry
// message, because the message went stale the moment the count stopped being
// six for every plan: `confirmationWordsV1` gives six, a downgrade prepends the
// literal word DOWNGRADE for seven, and the notice still said "six words" for
// both. An out-of-range count falls back to the digits instead of refusing — the
// notice must never be the thing that fails, since the owner has already mistyped.
const WORD_COUNT_NAMES_V1 = Object.freeze(["zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten"]);
export function consentCountPhraseV1(words) {
  const count = Array.isArray(words) ? words.length : 0;
  return WORD_COUNT_NAMES_V1[count] ?? String(count);
}

const INVOKING_FLAGS_V1 = Object.freeze(["--invoking-user", "--invoking-uid", "--invoking-gid"]);

export function parseInvokingArgumentsV1(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string" || value.includes("\0")))
    throw updaterRefuseV1("arguments_refused");
  const values = {}, args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!INVOKING_FLAGS_V1.includes(value)) { args.push(value); continue; }
    const identity = argv[index + 1];
    if (identity === undefined || values[value] !== undefined) throw updaterRefuseV1("invoking_user_refused");
    values[value] = identity; index += 1;
  }
  if (INVOKING_FLAGS_V1.every(flag => values[flag] === undefined)) return Object.freeze({ args, invokingUser: undefined });
  const user = values["--invoking-user"], uidText = values["--invoking-uid"], gidText = values["--invoking-gid"];
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(user ?? "") || !/^\d{1,10}$/u.test(uidText ?? "")
      || !/^\d{1,10}$/u.test(gidText ?? "")) throw updaterRefuseV1("invoking_user_refused");
  const uid = Number(uidText), gid = Number(gidText);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1
      || uid > 0x7fffffff || gid > 0x7fffffff) throw updaterRefuseV1("invoking_user_refused");
  return Object.freeze({ args, invokingUser: Object.freeze({ user, uid, gid }) });
}

function parsePairsV1(args, accepted) {
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw updaterRefuseV1("arguments_refused");
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!accepted.has(name) || value === undefined || flags[name] !== undefined)
      throw updaterRefuseV1("arguments_refused");
    flags[name] = value;
    if (["--root", "--bootstrap", "--rehearsal-config", "--e2e2-evidence-log"].includes(name)
      && !installerPathV1(value)) throw updaterRefuseV1("arguments_refused");
  }
  return flags;
}

// The SAME rule the installer applies to every path it is handed (installer.mjs `absolute`),
// applied here so the parser never returns a value the installer will only refuse later.
// Relative, empty, "/", anything with a "." or ".." segment, a trailing slash, an over-long
// path, a NUL or any other control or format character is refused. A path that survives this
// and then fails downstream is a genuine later problem, not a trap set by the parser.
function installerPathV1(value) {
  if (typeof value !== "string" || value.length <= 1 || value.length > 4095
    || !isAbsolute(value) || resolve(value) !== value || value.endsWith("/")
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value))
    throw updaterRefuseV1("arguments_refused");
  return value;
}

export function parseInstallerArgumentsV1(verb, args, { root = DEFAULT_CONTROL_ROOM_ROOT_V1, invokingUser } = {}) {
  if (!installerPathV1(root)) throw updaterRefuseV1("arguments_refused");
  if (verb === "status") {
    const flags = parsePairsV1(args, new Set(["--root"]));
    return Object.freeze({ command: verb, root: installerPathV1(flags["--root"] ?? root) });
  }
  if (verb === "uninstall-fresh") {
    const flags = parsePairsV1(args, new Set(["--root", "--rehearsal-config"]));
    if (!invokingUser) throw updaterRefuseV1("invoking_user_refused");
    if (flags["--rehearsal-config"] !== undefined) installerPathV1(flags["--rehearsal-config"]);
    return Object.freeze({ command: verb,
      root: flags["--root"] === undefined
        ? (flags["--rehearsal-config"] === undefined ? installerPathV1(root) : undefined)
        : installerPathV1(flags["--root"]),
      rehearsalConfig: flags["--rehearsal-config"], invokingUser });
  }
  if (verb === "install") {
    const flags = parsePairsV1(args, new Set(["--root", "--commit", "--bootstrap", "--web-port", "--i-am-replacing-live",
      "--rehearsal-config", "--fresh-database", "--authenticator", "--e2e2-evidence-log"]));
    if (flags["--commit"] !== undefined && !/^[a-f0-9]{40}$/u.test(flags["--commit"]))
      throw updaterRefuseV1("arguments_refused");
    if (flags["--web-port"] !== undefined && (!/^\d{1,5}$/u.test(flags["--web-port"])
      || !Number.isSafeInteger(Number(flags["--web-port"]))
      || Number(flags["--web-port"]) < 1024 || Number(flags["--web-port"]) > 65535))
      throw updaterRefuseV1("arguments_refused");
    if (flags["--i-am-replacing-live"] !== undefined && flags["--i-am-replacing-live"] !== "yes")
      throw updaterRefuseV1("arguments_refused");
    if (flags["--fresh-database"] !== undefined && flags["--fresh-database"] !== "yes")
      throw updaterRefuseV1("arguments_refused");
    if (flags["--authenticator"] !== undefined && flags["--authenticator"] !== "software")
      throw updaterRefuseV1("arguments_refused");
    if (flags["--rehearsal-config"] !== undefined) installerPathV1(flags["--rehearsal-config"]);
    if (flags["--e2e2-evidence-log"] !== undefined) installerPathV1(flags["--e2e2-evidence-log"]);
    if (!invokingUser) throw updaterRefuseV1("invoking_user_refused");
    if (flags["--bootstrap"] !== undefined) installerPathV1(flags["--bootstrap"]);
    return Object.freeze({ command: verb,
      root: flags["--root"] === undefined
        ? (flags["--rehearsal-config"] === undefined ? installerPathV1(root) : undefined)
        : installerPathV1(flags["--root"]),
      commit: flags["--commit"],
      bootstrap: flags["--bootstrap"],
      webPort: flags["--web-port"] === undefined
        ? flags["--rehearsal-config"] === undefined ? DEFAULT_CONTROL_ROOM_WEB_PORT_V1 : undefined : Number(flags["--web-port"]),
      replacingLive: flags["--i-am-replacing-live"] === "yes", rehearsalConfig: flags["--rehearsal-config"],
      freshDatabase: flags["--fresh-database"] === "yes", authenticator: flags["--authenticator"],
      e2e2EvidenceLog: flags["--e2e2-evidence-log"], invokingUser });
  }
  throw updaterRefuseV1("arguments_refused");
}

export function installerPortModulePathV1(environment = process.env, geteuid = () => process.geteuid?.() ?? -1) {
  return geteuid() === 0 ? undefined : environment.CONTROL_ROOM_INSTALLER_PORT_MODULE;
}

async function installerPortsV1(options) {
  if (options.installerPorts) return options.installerPorts;
  const modulePath = installerPortModulePathV1(options.environment ?? process.env, options.getuid);
  return modulePath ? (await import(pathToFileURL(modulePath).href)).default
    : (await import("./cli/control-room-native-ports.mjs")).default;
}

function requireInstallerRootV1(ports) {
  if (!ports || typeof ports.geteuid !== "function" || ports.geteuid() !== 0) {
    const error = new Error("root_required"); error.code = "root_required"; throw error;
  }
}

function requireRootV1(context, verb) {
  if (context.getuid() !== 0) throw updaterRefuseV1(`updater_${verb.replaceAll("-", "_")}_needs_root`);
}

function announceSudoV1(context, action) {
  context.stdout(`Control Room is asking for your Mac password to: ${action}.\n`);
}

/**
 * `initial` for a Mac with no passkey, `add` for every one after it.
 *
 * The ledger is the only authority on which case this is, read through the SAME
 * port `passkey list` uses, so the two verbs cannot disagree about whether the
 * Mac already has keys.
 *
 * FAIL-CLOSED, and deliberately: an unreadable ledger refuses rather than
 * defaulting to `initial`. The failure mode of guessing `initial` is a Mac that
 * already has keys getting a new one with no cooling-off and no authorization —
 * weaker than `add`. The failure mode of refusing is that the owner re-runs a
 * command; that is the right trade, and it is why this is a throw rather than a
 * `catch`.
 */
async function passkeyAddModeV1(authority, context, root) {
  const rows = authority ? await authority.listPasskeys()
    : await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
      requestId: `cli-${process.pid}-${Date.now()}`, verb: "passkey-list", arguments: [] });
  if (!Array.isArray(rows) || rows.length > 32) throw updaterRefuseV1("updater_passkey_control_reply_refused");
  // A REVOKED passkey still counts: it is a row in the ledger, and `initial` is
  // refused by the authority while any row exists. Choosing `add` here and being
  // refused by the authority would be correct-but-confusing; the count is the
  // same rule the authority applies, so the two agree.
  return rows.length === 0 ? "initial" : "add";
}

async function confirmationPlanV1(root, context, { announce = true, render = true } = {}) {
  requireRootV1(context, "confirm");
  if (announce) announceSudoV1(context, "confirm this updater plan");
  const index = JSON.parse(await readFileNoFollowV1(root, "updater-state/open-confirmation.json", { maxBytes: 4096 }));
  if (!index || typeof index.planId !== "string") throw updaterRefuseV1("updater_confirm_plan_refused");
  const plan = JSON.parse(await readFileNoFollowV1(root, `updater-state/plans/${index.planId}.json`, { maxBytes: 65536 }));
  if (!plan || plan.planId !== index.planId || !["updater", "setting"].includes(plan.kind))
    throw updaterRefuseV1("updater_confirm_plan_refused");
  const canonical = canonicalJsonV1(plan);
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  if (digest !== index.planDigest) throw updaterRefuseV1("updater_confirm_plan_digest_mismatch");
  const expected = confirmationWordsV1(digest);
  // ONE SOURCE for the consent phrase. `confirmV1` compares against it, the
  // prompt prints it, and the retry notice counts it, so the three can never
  // disagree about how many words the owner is being asked for.
  const consentWords = plan.updaterDerived?.downgrade === true ? ["DOWNGRADE", ...expected] : expected;
  if (render) context.stdout(`${typeof plan.artifact?.commit === "string"
      ? `Commit: ${plan.artifact.commit} (compare to the phone)\n` : ""}`
      + `Control Room updater plan ${plan.planId}\nKind: ${plan.kind}\nFrom: ${plan.from?.releaseId ?? "unknown"}\n`
      + `To: ${plan.artifact?.releaseId ?? "settings only"}\nChanges database: ${plan.updaterDerived?.changesDatabase === true ? "yes" : "no"}\n`
      + `Changes updater: ${plan.updaterDerived?.changesUpdater === true ? "yes" : "no"}\n`
      + `${Array.isArray(plan.classes) ? `Classes: ${plan.classes.join(", ")}\n` : ""}`
      + `${Number.isSafeInteger(plan.artifact?.sourceFileCount) ? `Source files: ${plan.artifact.sourceFileCount}\n` : ""}`
      + `${Number.isSafeInteger(plan.artifact?.outputFileCount) ? `Built files: ${plan.artifact.outputFileCount}\n` : ""}`
      + `${typeof plan.artifact?.inventoryDigest === "string" ? `Runtime inventory: ${plan.artifact.inventoryDigest}\n` : ""}`
      + `${plan.updaterDerived?.sandboxTestsRan === false ? "No sandbox tests were run.\n" : ""}`
      + `${plan.updaterDerived?.downgrade === true ? "DOWNGRADE: this release is older, or advancement from your installed release could not be verified. Explicit confirmation is required.\n" : ""}`
      + `Confirmation: ${consentWords.join(" ")}\n`);
  return { index, plan, digest, expected, consentWords };
}

export async function confirmV1(root, words, context, options = {}) {
  const { index, plan, digest, consentWords } = await confirmationPlanV1(root, context, options);
  if (words.join(" ") !== consentWords.join(" ")) throw updaterRefuseV1("updater_confirm_words_refused");
  await atomicWriteNoFollowV1(root, `updater-state/confirmations/${plan.planId}.json`, `${JSON.stringify({
    schema: "control-room.mac-confirmation/v1", planId: plan.planId, planDigest: digest, confirmed: true,
    confirmedAt: context.now().toISOString(),
    ...(plan.updaterDerived?.downgrade === true ? { downgradeConfirmed: true } : {}),
  })}\n`);
  return 0;
}

export async function authorizeAttendedInstallV1(root, context) {
  const { consentWords } = await confirmationPlanV1(root, context, { announce: false, render: true });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const words = (await context.stdinLine()).trim().split(/\s+/u);
    try { return await confirmV1(root, words, context, { announce: false, render: false }); }
    catch (error) {
      if (error?.code !== "updater_confirm_words_refused" || attempt === 3) throw error;
      // The COUNT comes from the same plan `confirmV1` refused against, because
      // it stopped being constant: `confirmationWordsV1` gives six digest-bound
      // words, and a downgrade adds the literal word DOWNGRADE in front for SEVEN.
      // A hardcoded "six" told a downgrade owner that the seven words they had
      // just been shown were the wrong number of words.
      context.stdout(`Those ${consentCountPhraseV1(consentWords)} words did not match. `
        + `Try again (${3 - attempt} ${attempt === 2 ? "try" : "tries"} left).\n`);
    }
  }
  throw updaterRefuseV1("updater_confirm_words_refused");
}

export function bufferedLineReaderV1(input) {
  let buffer = "", queuedBytes = 0, ended = false, pendingLf = false, failure;
  let raw = false;
  const lines = [], waiters = [];
  const takeLine = () => {
    const line = lines.shift();
    if (line !== undefined) queuedBytes -= Buffer.byteLength(line, "utf8") + 1;
    return line;
  };
  const takeBuffer = () => { const value = buffer; buffer = ""; return value; };
  const settle = () => {
    while (waiters.length > 0 && (lines.length > 0 || ended || failure)) {
      const waiter = waiters.shift();
      if (failure) waiter.reject(failure);
      else waiter.resolve(takeLine() ?? takeBuffer());
    }
  };
  const onData = chunk => {
    // D10: one reader for both modes. An empty chunk keeps a pending LF; an LF that
    // completes a CR from the previous chunk is dropped once (r5sfix).
    let text = chunk.toString("utf8");
    if (text.length === 0) return;
    if (pendingLf) { if (text.startsWith("\n")) text = text.slice(1); pendingLf = false; }
    // Non-raw reads: a Ctrl-C reaches readCodeV1 as its own line (r5sfix's signal path).
    if (!raw && text.includes("\u0003")) {
      buffer = ""; pendingLf = false; lines.length = 0; queuedBytes = 2;
      lines.push("\u0003"); settle(); return;
    }
    for (const character of text) {
      // Raw reads (int9): Ctrl-C or Ctrl-D cancels at once, and Delete/Backspace edit.
      if (raw && (character === "\u0003" || character === "\u0004")) {
        buffer = ""; pendingLf = false; lines.length = 0; queuedBytes = 0;
        const waiter = waiters.shift();
        waiter?.reject(updaterRefuseV1("updater_passkey_code_interrupted"));
        return;
      }
      if (raw && (character === "\u007f" || character === "\b")) buffer = buffer.slice(0, -1);
      else buffer += character;
    }
    for (;;) {
      const newline = buffer.search(/[\r\n]/u);
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      pendingLf = buffer[newline] === "\r" && newline + 1 === buffer.length;
      const width = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(newline + width);
      if (Buffer.byteLength(line, "utf8") > 1024) failure = updaterRefuseV1("updater_terminal_input_refused");
      else { lines.push(line); queuedBytes += Buffer.byteLength(line, "utf8") + 1; }
    }
    if (queuedBytes + Buffer.byteLength(buffer, "utf8") > 8192)
      failure = updaterRefuseV1("updater_terminal_input_refused");
    settle();
  };
  const onEnd = () => { ended = true; settle(); };
  const onError = () => { failure = updaterRefuseV1("updater_terminal_input_refused"); settle(); };
  input.on("data", onData); input.once("end", onEnd); input.once("error", onError);
  return Object.freeze({ readLine(signal, options = {}) {
    if (signal?.aborted) return Promise.reject(updaterRefuseV1("updater_passkey_code_interrupted"));
    if (waiters.length) return Promise.reject(updaterRefuseV1("updater_terminal_read_busy"));
    if (failure) return Promise.reject(failure);
    if (lines.length) return Promise.resolve(takeLine());
    if (ended) return Promise.resolve(takeBuffer());
    raw = options.raw === true;
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener("abort", abort); raw = false; };
      const waiter = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      const abort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        buffer = ""; pendingLf = false;
        waiter.reject(updaterRefuseV1("updater_passkey_code_interrupted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      waiters.push(waiter);
    });
  },
  close() {
    for (const waiter of waiters.splice(0)) waiter.reject(updaterRefuseV1("updater_terminal_input_refused"));
    input.off("data", onData); input.off("end", onEnd); input.off("error", onError); input.pause?.();
  } });
}

export async function runUpdaterCliV1(argv, options = {}) {
  if (Array.isArray(argv) && argv.length === 1 && argv[0] === "--print-capabilities") {
    const output = options.stdout ?? (text => process.stdout.write(text));
    output(`${JSON.stringify(CONTROL_ROOM_INSTALLER_CAPABILITIES_V1)}\n`); return 0;
  }
  const root = options.root ?? DEFAULT_CONTROL_ROOM_ROOT_V1;
  const output = options.stdout ?? (text => process.stdout.write(text));
  const input = options.stdin ?? process.stdin;
  const defaultReader = options.stdinLine === undefined ? bufferedLineReaderV1(input) : null;
  const context = { getuid: options.getuid ?? (() => process.getuid?.() ?? -1), now: options.now ?? (() => new Date()),
    stdout: output,
    stderr: options.stderr ?? (text => process.stderr.write(text)),
    send: options.send ?? sendControlRequestV1,
    stdinLine: options.stdinLine ?? (() => defaultReader.readLine()) };
  const terminal = options.terminal ?? Object.freeze({ write: context.stdout,
    readLine: options.readComparisonCode ?? (signal => defaultReader.readLine(signal, { raw: true })),
    isTTY: options.readComparisonCode !== undefined || options.stdinLine === undefined && input.isTTY === true,
    setRawMode: options.readComparisonCode === undefined ? value => input.setRawMode?.(value) : () => {} });
try {
  const invocation = parseInvokingArgumentsV1(argv);
  const [verb, ...args] = invocation.args;
  if (verb === "status") {
    const parsed = parseInstallerArgumentsV1(verb, args, { root, invokingUser: invocation.invokingUser });
    const status = await statusControlRoomV1(parsed);
    context.stdout(`${JSON.stringify(status, null, 2)}\n`); return 0;
  }
  if (verb === "confirm") return confirmV1(root, args, context);
  if (verb === "install") {
    announceSudoV1(context, "build and install this exact commit");
    const ports = await installerPortsV1(options); requireInstallerRootV1(ports);
    const parsed = parseInstallerArgumentsV1(verb, args, { root, invokingUser: invocation.invokingUser });
    const result = await installControlRoomV1({ ...(options.installerOptions ?? {}), ...parsed,
      terminal, authorize: async () => authorizeAttendedInstallV1(parsed.root, context), ports });
    // A stopped Face ID step is not Ready (atk-fa F8): say so plainly, and what the guide says to do.
    if (result.passkey && result.passkey.status !== "registered") {
      context.stdout(`Not ready: Face ID is NOT set up (the passkey step stopped: ${result.passkey.reason}). `
        + `Control Room release ${result.version} is installed and current. Self-update is Off. `
        + "Stop here and show this to the lead after reopening Claude. Do not retry, and do not run passkey add yourself.\n");
    } else context.stdout(`Ready: Control Room release ${result.version} is current. Self-update is Off.\n`);
    return 0;
  }
  if (verb === "uninstall-fresh") {
    const ports = await installerPortsV1(options); requireInstallerRootV1(ports);
    const parsed = parseInstallerArgumentsV1(verb, args, { root, invokingUser: invocation.invokingUser });
    const result = await uninstallFreshControlRoomV1({ ...(options.installerOptions ?? {}), ...parsed,
      ports });
    context.stdout(`Fresh install removed. Retained at ${result.retained}.\n`);
    return 0;
  }
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
      if (terminal.isTTY !== true) throw updaterRefuseV1("updater_passkey_code_terminal_required");
      // THE MODE DECIDES WHETHER THIS PASSKEY WORKS TONIGHT, so it is chosen from
      // the ledger rather than assumed. `add` is the ceremony that makes a new
      // passkey wait out a 24-hour cooling-off window unless an ACTIVE passkey
      // approves it; on a Mac with no passkey at all there is none to approve it,
      // so `add` on a fresh install produces a first passkey that cannot sign
      // anything for a day. `initial` is the ceremony that has no cooling-off and
      // no authorization step — and the authority REFUSES `initial` the moment
      // the ledger holds any passkey, so this cannot become a second way to add a
      // later passkey without approval.
      //
      // The count is read through the same port the rest of this verb uses, and an
      // unreadable ledger is a refusal rather than a guess: choosing `initial`
      // because the read failed would hand the first passkey no cooling-off when
      // the Mac may already have keys.
      const mode = await passkeyAddModeV1(authority, context, root);
      const registration = authority ? await authority.beginRegistration({ mode })
        : await context.send(join(root, "updater-state/control.sock"), { schema: "control-room.updater-control/v1",
          requestId: `cli-${process.pid}-${Date.now()}`, verb: "passkey-add-begin",
          arguments: mode === "initial" ? ["initial"] : [] });
      if (!registration || typeof registration.registrationSecret !== "string"
          || !/^[A-Za-z0-9_-]{43}$/u.test(registration.registrationSecret)
          || typeof registration.expectedOrigin !== "string" && typeof registration.config?.expectedOrigin !== "string")
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      const expectedOrigin = registration.expectedOrigin ?? registration.config.expectedOrigin;
      context.stdout(`${expectedOrigin}/setup#reg=${registration.registrationSecret}&mode=${mode}\n`);
      // The message is the only place the owner learns this passkey is live
      // tonight, so it is printed per mode rather than as one message with a
      // caveat: the INACTIVE case is the one that must not read as success.
      context.stdout(mode === "initial"
        ? "The registration expires in 30 minutes. This is the first passkey on this Mac, so it is active as soon as you finish.\n"
        : "The registration expires in 30 minutes. The new passkey needs approval from an active passkey, or it remains inactive for 24 hours.\n");
      const typedCode = await readCodeV1(terminal);
      const result = authority ? await authority.completeRegistration({ registrationSecret: registration.registrationSecret,
        typedCode }) : await context.send(join(root, "updater-state/control.sock"), {
          schema: "control-room.updater-control/v1", requestId: `cli-${process.pid}-${Date.now()}`,
          verb: "passkey-add-complete", arguments: [registration.registrationSecret, typedCode] }, { timeoutMs: 15_000 });
      if (!result || result.coolingOffUntil !== null && typeof result.coolingOffUntil !== "string")
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      if (result.coolingOffUntil && result.coolingOffNoticesEnqueued !== true)
        throw updaterRefuseV1("updater_passkey_control_reply_refused");
      context.stdout(result.coolingOffUntil
        ? `Passkey added. It is inactive until ${result.coolingOffUntil}. Phone warning delivery is not available yet; review passkeys on this Mac.\n`
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
      requestId: `cli-${process.pid}-${Date.now()}`, verb, arguments: args },
      { timeoutMs: ["check-and-continue", "rollback", "backup-now"].includes(verb) ? 300000 : 5000 });
    context.stdout("The updater accepted the owner fallback request.\n"); return 0;
  }
  if (SUDO_ONLY_VERBS_V1.has(verb)) {
    requireRootV1(context, verb);
    announceSudoV1(context, `perform ${verb}`);
    throw updaterRefuseV1("updater_cli_port_not_implemented");
  }
  context.stderr("Usage: control-room status | install --commit <sha> | uninstall-fresh | confirm <six words> | passkey add|list|revoke <number> | pause | resume | stop | backup-now | check-and-continue | repair-serve | rollback\n");
  return 64;
} catch (error) {
  context.stderr(updaterRecoveryLineV1(error));
  throw error;
} finally { defaultReader?.close(); }
}

export function updaterRecoveryLineV1(error) {
  const code = error?.code ?? error?.message;
  const summary = code === "install_rollback_incomplete"
    ? "The install could not be fully undone. Leave its files in place."
    : error?.installRollbackComplete === true
      ? "The attempted install was undone."
      : code === "updater_passkey_code_interrupted"
        ? "Code entry stopped. Control Room may remain installed."
        : code === "updater_passkey_code_refused"
          ? "The code was not six letters and numbers. Control Room may remain installed."
          : "The command stopped; its installation state is not confirmed.";
  return `${summary} Do not retry. Keep the Terminal message and show the lead after reopening Claude.\n`;
}

// The shared entry guard, asked the one question it can answer here — "is this
// the entry?" — and its refusal is only allowed to BE the answer when there IS
// an entry to be wrong about.
//
// This file is both an entry and an import target:
// `control-room-native-ports.mjs` imports it, so anything that imports THAT
// (the installer's own `the archived installer entry and native ports load
// without node_modules` does, through `--eval`) must reach this module's body
// without running its CLI. Two `process.argv[1]` shapes make that an import
// rather than an entry, both MEASURED with `--eval` and `--input-type=module`:
//
//   absent        — `node --input-type=module --eval "<code>"` with no extra
//                   argument leaves `argv` at one element. The helper answers
//                   `false` and this body does not run.
//
//   "file:…"      — under `--eval` the first extra argument lands in `argv[1]`
//                   verbatim, which is how `--eval "await import(process.argv[1])"
//                   <url>` names the module to load. MEASURED: `node <a file: URL>`
//                   fails with `Cannot find module '<cwd>/file:/…'`, so a `file:`
//                   URL is never a real entry. The helper REFUSES this shape,
//                   which is why the "import" test in `invoked-directly.test.mjs`
//                   loads the module with `await import()` and passes the URL as
//                   a REAL PATH rather than as a URL.
//
// The pre-guard that used to sit here (`typeof argv[1] === "string" && … &&
// !startsWith("file:") && isMainModuleV1(…)`) duplicated that decision in three
// files. It is gone with the second copy of the guard; the helper is the one
// definition, and the repository-wide policy test still rejects any direct
// comparison outside it.
if (isMainModuleV1(process.argv[1], import.meta.url)) runUpdaterCliV1(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  const message = typeof error?.userMessage === "string" ? error.userMessage
    : typeof error?.code === "string" ? error.code : "updater_cli_failed";
  process.stderr.write(`${message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 200)}\n`); process.exitCode = 1;
});

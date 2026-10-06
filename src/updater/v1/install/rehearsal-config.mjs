import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
import { isRehearsalHostnameV1 } from "../../../installer/shared/rehearsal-hostname.mjs";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath, lstat, stat } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, normalize } from "node:path";

export const REHEARSAL_CONFIG_SCHEMA_V1 = "control-room.e2e2-rehearsal-config/v1";
export const LIVE_ROOT_V1 = "/Library/Application Support/Control Room";
export const LIVE_ACCOUNTS_V1 = Object.freeze(["_controlroom", "_crdb", "_crbuild"]);
export const LIVE_LABELS_V1 = Object.freeze([
  "xyz.agentcontrolroom.postgres", "xyz.agentcontrolroom.supervisor", "xyz.agentcontrolroom.gateway",
  "xyz.agentcontrolroom.nightly-backup", "xyz.agentcontrolroom.updater", "xyz.agentcontrolroom.updater-guard",
]);
export const LIVE_PORTS_V1 = Object.freeze([3210, 3211]);
export const SERVICE_ROLES_V1 = Object.freeze([
  "postgresql17", "supervisor", "fleet-gateway", "nightly-backup", "updater", "updater-guard",
]);

const MAX_CONFIG_BYTES = 64 * 1024;
const LIVE_FILES = Object.freeze([
  "Protected/config/host.json", "Protected/config/local-owner-session.json", "Protected/config/fleet-gateway.json",
  "Protected/config/supervisor.json", "Protected/config/backup.json", "updater-state/updater.json",
]);
const accountPattern = /^_[a-z][a-z0-9_]{1,30}$/u;
const labelPattern = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])$/u;
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const absolute = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && normalize(value) === value && value !== "/" && !/[\u0000-\u001f\u007f]/u.test(value);

function validateIdentity(value) {
  const required = ["schema", "root", "accounts", "launchdLabels", "ports", "tailnetName", "database", "tailscale",
    "authenticator", "installerArgumentTemplate", "observedInstallerFlags", "missingInstallerFlags"];
  const allowed = new Set([...required, "liveSourcesRead", "liveSnapshotSha256"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))
    || value.schema !== REHEARSAL_CONFIG_SCHEMA_V1 || !absolute(value.root)
    || !exactKeys(value.accounts, ["service", "database", "builder"])
    || Object.values(value.accounts).some(name => typeof name !== "string" || !accountPattern.test(name))
    || new Set(Object.values(value.accounts)).size !== 3
    || !exactKeys(value.launchdLabels, SERVICE_ROLES_V1)
    || Object.values(value.launchdLabels).some(label => typeof label !== "string" || !labelPattern.test(label) || !label.includes(".rehearsal."))
    || new Set(Object.values(value.launchdLabels)).size !== SERVICE_ROLES_V1.length
    || !exactKeys(value.ports, ["web", "gateway"])
    || !Number.isSafeInteger(value.ports.web) || !Number.isSafeInteger(value.ports.gateway)
    || value.ports.web < 1024 || value.ports.web > 65535 || value.ports.gateway < 1024 || value.ports.gateway > 65535
    || value.ports.web === value.ports.gateway
    || typeof value.tailnetName !== "string" || value.tailnetName !== value.tailnetName.toLowerCase()
    || !isRehearsalHostnameV1(value.tailnetName)
    || !exactKeys(value.database, ["mode"]) || value.database.mode !== "fresh"
    || !exactKeys(value.tailscale, ["mode", "expectedStepOutcome", "mutationAllowed"])
    || value.tailscale.mode !== "skip" || value.tailscale.expectedStepOutcome !== "skipped (rehearsal)"
    || value.tailscale.mutationAllowed !== false
    || !exactKeys(value.authenticator, ["kind", "userVerification"]) || value.authenticator.kind !== "software"
    || value.authenticator.userVerification !== "required"
    || !Array.isArray(value.installerArgumentTemplate) || !Array.isArray(value.observedInstallerFlags)
    || !Array.isArray(value.missingInstallerFlags)
    || [value.installerArgumentTemplate, value.observedInstallerFlags, value.missingInstallerFlags]
      .some(items => items.some(item => typeof item !== "string"))
    || value.liveSourcesRead !== undefined && (!Number.isSafeInteger(value.liveSourcesRead) || value.liveSourcesRead < 0)
    || value.liveSnapshotSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(value.liveSnapshotSha256)) {
    refuse("rehearsal_config_refused");
  }
  return value;
}

function collectLiveIdentity(value, key, live) {
  const pending = [{ value, key, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (entry.depth > 64 || ++nodes > 100000) refuse("rehearsal_config_refused");
    if (entry.value && typeof entry.value === "object") {
      for (const [name, item] of Object.entries(entry.value)) pending.push({ value: item,
        key: Array.isArray(entry.value) ? entry.key : name, depth: entry.depth + 1 });
    } else collectLiveScalar(entry.value, entry.key, live);
  }
}

function collectLiveScalar(value, key, live) {
  if (typeof value === "number" && Number.isSafeInteger(value) && /port/iu.test(key)) live.ports.add(value);
  if (typeof value !== "string") return;
  const lower = value.toLowerCase();
  if (/^(?:account|user|username|serviceAccount|databaseAccount|builderAccount)$/iu.test(key)
    || accountPattern.test(value)) live.accounts.add(lower);
  if (/label/iu.test(key) || value.startsWith("xyz.agentcontrolroom.")) live.labels.add(lower);
  if ((/root/iu.test(key) || value.normalize("NFC").toLowerCase().startsWith(LIVE_ROOT_V1.toLowerCase())) && absolute(value)) {
    live.roots.add(normalize(value));
  }
  if (/^(?:rpId|hostname|tailnet|tailnetName)$/iu.test(key) && hostPattern.test(lower)) live.hosts.add(lower);
  if (/origin/iu.test(key)) { try { live.hosts.add(new URL(value).hostname.toLowerCase()); } catch { /* data only */ } }
}

async function liveJsonIfPresent(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(error => error?.code === "ENOENT" ? null : refuse("rehearsal_config_refused"));
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse("rehearsal_config_refused");
    try { return parseStrictJsonV1((await handle.readFile()).toString("utf8")); } catch { refuse("rehearsal_config_refused"); }
  } finally { await handle.close(); }
}

function foldedRoot(path) { return normalize(path).normalize("NFC").toLowerCase(); }
function rootsOverlap(left, right) {
  const a = foldedRoot(left), b = foldedRoot(right);
  return a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// New rehearsal directories need not exist yet. Resolve the nearest existing
// ancestor, preserving the missing suffix; errors other than absence fail closed.
async function canonicalRoot(path) {
  let current = path; const suffix = [];
  for (;;) {
    try {
      const ancestor = await realpath(current), canonical = join(ancestor, ...suffix), identities = [];
      // A firmlink or bind mount can retain another spelling after realpath.
      // Project the missing suffix from each existing ancestor's device/inode.
      // Shared ancestors alone are not overlap: sibling suffixes stay disjoint.
      let remainder = suffix.join("/");
      for (let directory = ancestor; ; directory = dirname(directory)) {
        const entry = await stat(directory);
        if (!entry.isDirectory()) refuse("rehearsal_config_refused");
        identities.push({ dev: entry.dev, ino: entry.ino, remainder });
        if (dirname(directory) === directory) break;
        remainder = [basename(directory), remainder].filter(Boolean).join("/");
      }
      return { canonical, identities };
    }
    catch (error) {
      if (error?.code !== "ENOENT" || current === "/") refuse("rehearsal_config_refused");
      const entry = await lstat(current).catch(error => error?.code === "ENOENT"
        ? null : refuse("rehearsal_config_refused"));
      if (entry) refuse("rehearsal_config_refused"); // A dangling alias is not a missing directory.
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
}

async function assertRootsDisjoint(root, roots, liveRoot) {
  for (const live of roots) if (rootsOverlap(root, live)) refuse("rehearsal_config_refused");
  const candidate = await canonicalRoot(root), canonical = candidate.canonical;
  for (const live of roots) {
    // An injected live root replaces the installation for fixture checks. The
    // default spelling still remains forbidden without reading that installation.
    if (live === LIVE_ROOT_V1 && liveRoot !== LIVE_ROOT_V1) continue;
    const existing = await canonicalRoot(live), liveCanonical = existing.canonical;
    if (candidate.identities.some(left => existing.identities.some(right => left.dev === right.dev && left.ino === right.ino
      && rootsOverlap(`/${left.remainder}`, `/${right.remainder}`)))) refuse("rehearsal_config_refused");
    if (rootsOverlap(canonical, liveCanonical) || rootsOverlap(root, liveCanonical)
      || rootsOverlap(canonical, live)) refuse("rehearsal_config_refused");
  }
}

export async function assertNoLiveRehearsalCollisionsV1(value, liveRoot = LIVE_ROOT_V1) {
  validateIdentity(value);
  if (!absolute(liveRoot)) refuse("rehearsal_config_refused");
  const live = { roots: new Set([LIVE_ROOT_V1, liveRoot]), accounts: new Set(LIVE_ACCOUNTS_V1), labels: new Set(LIVE_LABELS_V1),
    ports: new Set(LIVE_PORTS_V1), hosts: new Set() };
  await assertRootsDisjoint(value.root, live.roots, liveRoot);
  for (const relative of LIVE_FILES) {
    const parsed = await liveJsonIfPresent(join(liveRoot, relative));
    if (parsed !== undefined) collectLiveIdentity(parsed, "", live);
  }
  await assertRootsDisjoint(value.root, live.roots, liveRoot);
  if (Object.values(value.accounts).some(name => live.accounts.has(name.toLowerCase()))
    || Object.values(value.launchdLabels).some(label => live.labels.has(label.toLowerCase()))
    || Object.values(value.ports).some(port => live.ports.has(port)) || live.hosts.has(value.tailnetName)) {
    refuse("rehearsal_config_refused");
  }
  return value;
}

export async function loadRehearsalConfigV1(path, runtime = {}) {
  if (!absolute(path)) refuse("rehearsal_config_refused");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse("rehearsal_config_refused"));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_CONFIG_BYTES
      || (before.mode & 0o077) !== 0) refuse("rehearsal_config_refused");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.includes(0)) {
      refuse("rehearsal_config_refused");
    }
    let value; try { value = parseStrictJsonV1(bytes.toString("utf8")); } catch { refuse("rehearsal_config_refused"); }
    validateIdentity(value);
    await assertNoLiveRehearsalCollisionsV1(value, runtime.liveRoot ?? LIVE_ROOT_V1);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const servicePolicy = Object.freeze(SERVICE_ROLES_V1.map(role => Object.freeze({ role,
      label: value.launchdLabels[role], plistPath: `/Library/LaunchDaemons/${value.launchdLabels[role]}.plist` })));
    return Object.freeze({ path, digest, root: value.root, accountsPolicy: Object.freeze({
      schema: "control-room.accounts/v1", accounts: Object.freeze({ ...value.accounts }),
    }), servicePolicy, webPort: value.ports.web, gatewayPort: value.ports.gateway,
    tailnetIdentity: value.tailnetName, tailscale: Object.freeze({ ...value.tailscale }),
    authenticator: "software", freshDatabase: true });
  } finally { await handle.close(); }
}

export function assertRehearsalInvocationV1(rehearsal, options) {
  if (options.moveLiveDatabase === true) refuse("rehearsal_move_live_database_refused");
  if (!rehearsal || options.root !== rehearsal.root || options.webPort !== rehearsal.webPort
    || options.freshDatabase !== true || options.authenticator !== rehearsal.authenticator
    || typeof options.e2e2EvidenceLog !== "string") refuse("rehearsal_invocation_refused");
  return rehearsal;
}

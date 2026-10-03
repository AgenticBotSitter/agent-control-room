import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
import { isRehearsalHostnameV1 } from "../../../installer/shared/rehearsal-hostname.mjs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { updaterRefuseV1 } from "../contracts.mjs";

export const REHEARSAL_CONFIG_SCHEMA_V1 = "control-room.updater-rehearsal-config/v1";
export const REHEARSAL_MARKER_SCHEMA_V1 = "control-room.updater-rehearsal-root/v1";
export const FORBIDDEN_REHEARSAL_PORTS_V1 = Object.freeze(new Set([3310, 7864, 8443]));
const ACCOUNT_V1 = /^_[a-z][a-z0-9_-]{2,30}$/u;
const LABEL_PREFIX_V1 = /^xyz\.agentcontrolroom\.rehearsal\.[a-z0-9][a-z0-9.-]{0,48}$/u;

function refuse(code) { throw updaterRefuseV1(code); }
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function inside(root, path) {
  const rest = relative(root, path);
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
function exactKeys(value, names, code) {
  if (!plain(value) || names.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !names.includes(key))) refuse(code);
}

export function parseRehearsalConfigV1(value) {
  exactKeys(value, ["schema", "mode", "rehearsalRoot", "rehearsalHostname", "expectedOrigin", "ports",
    "accounts", "daemonLabelPrefix", "allowRealRoot"], "rehearsal_config_refused");
  if (value.schema !== REHEARSAL_CONFIG_SCHEMA_V1 || !["throwaway", "real-root"].includes(value.mode))
    refuse("rehearsal_config_refused");
  if (typeof value.rehearsalRoot !== "string" || !isAbsolute(value.rehearsalRoot)
      || resolve(value.rehearsalRoot) !== value.rehearsalRoot || value.rehearsalRoot.includes("\0"))
    refuse("rehearsal_root_refused");
  const root = value.rehearsalRoot;
  if (root === "/" || root === "/Library" || root === "/Library/Application Support"
      || root === "/Library/Application Support/Control Room") refuse("rehearsal_live_root_refused");
  if (value.mode === "throwaway") {
    if (dirname(root) !== "/private/tmp" || !/^control-room-rehearsal-[A-Za-z0-9._-]+$/u.test(root.split("/").at(-1)))
      refuse("rehearsal_throwaway_root_refused");
    if (value.allowRealRoot !== false) refuse("rehearsal_real_root_authority_refused");
  } else {
    if (value.allowRealRoot !== true || root === "/Volumes/CRRehearsal"
        || !inside("/Volumes/CRRehearsal", root))
      refuse("rehearsal_real_root_authority_refused");
  }
  if (!isRehearsalHostnameV1(value.rehearsalHostname))
    refuse("rehearsal_hostname_refused");
  exactKeys(value.ports, ["web", "gateway", "postgres"], "rehearsal_ports_refused");
  const ports = Object.values(value.ports);
  if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535
      || FORBIDDEN_REHEARSAL_PORTS_V1.has(port)) || new Set(ports).size !== ports.length)
    refuse("rehearsal_ports_refused");
  const expectedOrigin = `https://${value.rehearsalHostname}:${value.ports.web}`;
  if (value.expectedOrigin !== expectedOrigin) refuse("rehearsal_expected_origin_refused");
  exactKeys(value.accounts, ["service", "database", "builder"], "rehearsal_accounts_refused");
  const accounts = Object.values(value.accounts);
  if (accounts.some(account => typeof account !== "string" || !ACCOUNT_V1.test(account)
      || !account.includes("rehearsal")) || new Set(accounts).size !== accounts.length)
    refuse("rehearsal_accounts_refused");
  if (typeof value.daemonLabelPrefix !== "string" || !LABEL_PREFIX_V1.test(value.daemonLabelPrefix))
    refuse("rehearsal_daemon_labels_refused");
  return Object.freeze({ ...value, ports: Object.freeze({ ...value.ports }),
    accounts: Object.freeze({ ...value.accounts }) });
}

export async function readRehearsalConfigV1(path) {
  let value;
  try { value = parseStrictJsonV1(await readFile(path, "utf8")); }
  catch { refuse("rehearsal_config_read_refused"); }
  return parseRehearsalConfigV1(value);
}

export async function assertRehearsalAncestryV1(root, { lstatPath = lstat } = {}) {
  const parts = root.split("/").filter(Boolean); let current = "/";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    const entry = await lstatPath(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0)
      refuse("rehearsal_root_ancestry_refused");
  }
  return true;
}

export async function prepareRehearsalRootV1(config, { geteuid = () => process.geteuid?.() ?? -1,
  ownersEnabled = async () => config.mode === "throwaway", lstatPath = lstat } = {}) {
  if (config.mode === "real-root" && geteuid() !== 0) refuse("rehearsal_real_root_needs_root");
  if (!await ownersEnabled(config.rehearsalRoot)) refuse("rehearsal_disk_owners_disabled");
  const markerPath = join(config.rehearsalRoot, ".control-room-rehearsal-root.json");
  try {
    const entry = await lstat(config.rehearsalRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) refuse("rehearsal_root_refused");
    let marker;
    try { marker = parseStrictJsonV1(await readFile(markerPath, "utf8")); }
    catch { refuse("rehearsal_root_marker_refused"); }
    if (marker?.schema !== REHEARSAL_MARKER_SCHEMA_V1 || marker.rehearsalHostname !== config.rehearsalHostname
        || marker.mode !== config.mode) refuse("rehearsal_root_marker_refused");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(config.rehearsalRoot, { mode: 0o700 });
    await writeFile(markerPath, `${JSON.stringify({ schema: REHEARSAL_MARKER_SCHEMA_V1,
      rehearsalHostname: config.rehearsalHostname, mode: config.mode })}\n`, { mode: 0o600, flag: "wx" });
  }
  const canonical = await realpath(config.rehearsalRoot);
  if (canonical !== config.rehearsalRoot) refuse("rehearsal_root_alias_refused");
  if (config.mode === "real-root") await assertRehearsalAncestryV1(canonical, { lstatPath });
  return Object.freeze({ root: canonical, ownersEnabled: true, mode: config.mode });
}

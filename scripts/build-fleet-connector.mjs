#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import { captureReleaseTrustV1 } from "./release-signing.mjs";

const run = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPoint = fileURLToPath(new URL("fleet/connector-bundle-entry.mjs", import.meta.url));
const sourceConnector = fileURLToPath(new URL("fleet/connector.mjs", import.meta.url));
const zodLicense = fileURLToPath(new URL("../third_party/zod/LICENSE", import.meta.url));
const RELEASE_SCHEMA = "control-room.fleet-connector-release/v1";
const refused = () => { throw new Error("fleet_connector_build_refused"); };

function cleanAbsolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && value !== "/" && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function cleanGitCommit() {
  const options = { cwd: projectRoot, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } };
  const { stdout: dirty } = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], options);
  if (dirty.trim()) refused();
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8",
    timeout: 5_000, maxBuffer: 4_096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) refused();
  return commit;
}

export function assertFleetConnectorBundleImportsV1(metafile) {
  const outputs = metafile && typeof metafile === "object" ? metafile.outputs : null;
  if (!outputs || typeof outputs !== "object") refused();
  const nonNodeImports = Object.values(outputs).flatMap(value => Array.isArray(value?.imports) ? value.imports : [])
    .filter(value => value?.external && (typeof value.path !== "string" || !value.path.startsWith("node:")));
  if (nonNodeImports.length) refused();
}

export function assertFleetConnectorBundledLicensesV1(metafile) {
  const inputs = metafile && typeof metafile === "object" ? metafile.inputs : null;
  const packages = new Set();
  if (inputs && typeof inputs === "object") for (const input of Object.keys(inputs)) {
    const marker = "node_modules/", start = input.lastIndexOf(marker);
    if (start < 0) continue;
    const parts = input.slice(start + marker.length).split("/");
    packages.add(parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0]);
  }
  if ([...packages].sort().join(",") !== "zod") refused();
}

async function prepareFleetConnectorReleaseV1({ root, builtFrom, allowRealHome, releaseTrust: trustValue }) {
  if (!cleanAbsolute(root)) refused();
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) refused();
  const canonicalHome = await realpath(homedir()).catch(() => resolve(homedir()));
  if (await realpath(root) === canonicalHome && allowRealHome !== true) refused();
  if (!/^[a-f0-9]{40}$/u.test(builtFrom)) refused();
  const source = await readFile(sourceConnector, "utf8");
  const version = /export const CONNECTOR_VERSION = "(\d+\.\d+\.\d+)";/u.exec(source)?.[1];
  if (!version) refused();
  let releaseTrust;
  try { releaseTrust = captureReleaseTrustV1(trustValue); } catch { refused(); }
  const output = await esbuild({ absWorkingDir: projectRoot, entryPoints: [entryPoint], bundle: true,
    platform: "node", format: "esm", target: "node20", charset: "utf8", legalComments: "none",
    sourcemap: false, minify: false, treeShaking: true, write: false, metafile: true,
    define: { __CONTROL_ROOM_RELEASE_TRUST_V1__: JSON.stringify(releaseTrust) },
    outfile: `connector-${version}.mjs` });
  if (output.outputFiles.length !== 1) refused();
  assertFleetConnectorBundleImportsV1(output.metafile);
  assertFleetConnectorBundledLicensesV1(output.metafile);
  const license = (await readFile(zodLicense, "utf8")).trimEnd().split("\n").map(line => `// ${line}`).join("\n");
  const bundled = Buffer.from(output.outputFiles[0].contents).toString("utf8");
  const shebangEnd = bundled.indexOf("\n") + 1;
  const bytes = Buffer.from(`${bundled.slice(0, shebangEnd)}// Control Room embedded release key ID: ${releaseTrust.keyId}\n// Bundled third-party licence notice: zod@4.1.12\n${license}\n\n${bundled.slice(shebangEnd)}`, "utf8");
  const file = `connector-${version}.mjs`;
  const manifest = Object.freeze({ schema: RELEASE_SCHEMA, version, file,
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, builtFrom });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, file, bytes, manifest, manifestBytes, releaseTrust };
}

async function writeFleetConnectorReleaseV1(prepared) {
  const { root, file, bytes, manifest, manifestBytes } = prepared;
  for (const [name, contents] of [[file, bytes], ["manifest.json", manifestBytes]]) {
    const target = join(root, name), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await rename(temporary, target);
  }
  const written = await stat(join(root, file));
  if (written.size !== manifest.size) refused();
  return Object.freeze({ root, manifest });
}

/** Build the release only from a clean checkout, so builtFrom is the commit whose source bytes esbuild read. */
/** @param {{ root?: string, allowRealHome?: boolean, releaseTrust?: object }} [input] */
export async function buildFleetConnectorReleaseV1({ root, allowRealHome = false, releaseTrust } = {}) {
  const builtFrom = await cleanGitCommit();
  const prepared = await prepareFleetConnectorReleaseV1({ root, builtFrom, allowRealHome, releaseTrust });
  return writeFleetConnectorReleaseV1(prepared);
}

/** Deterministic fixture builder. Production and CLI callers must use buildFleetConnectorReleaseV1. */
/** @param {{ root?: string, builtFrom?: string, allowRealHome?: boolean, releaseTrust?: object }} [input] */
export async function buildFleetConnectorReleaseForTestV1({ root, builtFrom, allowRealHome = false, releaseTrust } = {}) {
  return writeFleetConnectorReleaseV1(await prepareFleetConnectorReleaseV1({ root, builtFrom, allowRealHome,
    releaseTrust }));
}

function parse(args) {
  const values = { allowRealHome: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--i-am-the-installer") values.allowRealHome = true;
    else if (args[index] === "--root") values.root = resolve(args[++index] ?? "");
    else if (args[index] === "--release-trust") values.releaseTrustPath = resolve(args[++index] ?? "");
    else refused();
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const parsed = parse(process.argv.slice(2));
  Promise.resolve().then(async () => {
    if (!parsed.releaseTrustPath) refused();
    const info = await stat(parsed.releaseTrustPath);
    if (process.platform !== "win32" && (info.mode & 0o037) !== 0) refused();
    return buildFleetConnectorReleaseV1({ root: parsed.root, allowRealHome: parsed.allowRealHome,
      releaseTrust: JSON.parse(await readFile(parsed.releaseTrustPath, "utf8")) });
  })
    .then(value => process.stdout.write(`${JSON.stringify(value.manifest)}\n`))
    .catch(() => { process.stderr.write("Control Room connector build refused.\n"); process.exitCode = 1; });
}

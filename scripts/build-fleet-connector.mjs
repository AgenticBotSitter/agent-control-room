#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";

const run = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPoint = fileURLToPath(new URL("fleet/connector-bundle-entry.mjs", import.meta.url));
const sourceConnector = fileURLToPath(new URL("fleet/connector.mjs", import.meta.url));
const RELEASE_SCHEMA = "control-room.fleet-connector-release/v1";
const refused = () => { throw new Error("fleet_connector_build_refused"); };

function cleanAbsolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && value !== "/" && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function gitCommit() {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8",
    timeout: 5_000, maxBuffer: 4_096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  return stdout.trim();
}

export function assertFleetConnectorBundleImportsV1(metafile) {
  const outputs = metafile && typeof metafile === "object" ? metafile.outputs : null;
  if (!outputs || typeof outputs !== "object") refused();
  const nonNodeImports = Object.values(outputs).flatMap(value => Array.isArray(value?.imports) ? value.imports : [])
    .filter(value => value?.external && (typeof value.path !== "string" || !value.path.startsWith("node:")));
  if (nonNodeImports.length) refused();
}

/** @param {{ root?: string, builtFrom?: string, allowRealHome?: boolean }} [input] */
export async function buildFleetConnectorReleaseV1({ root, builtFrom, allowRealHome = false } = {}) {
  if (!cleanAbsolute(root)) refused();
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) refused();
  const canonicalHome = await realpath(homedir()).catch(() => resolve(homedir()));
  if (await realpath(root) === canonicalHome && allowRealHome !== true) refused();
  const commit = builtFrom ?? await gitCommit();
  if (!/^[a-f0-9]{40}$/u.test(commit)) refused();
  const source = await readFile(sourceConnector, "utf8");
  const version = /export const CONNECTOR_VERSION = "(\d+\.\d+\.\d+)";/u.exec(source)?.[1];
  if (!version) refused();
  const output = await esbuild({ absWorkingDir: projectRoot, entryPoints: [entryPoint], bundle: true,
    platform: "node", format: "esm", target: "node20", charset: "utf8", legalComments: "none",
    sourcemap: false, minify: false, treeShaking: true, write: false, metafile: true,
    outfile: `connector-${version}.mjs` });
  if (output.outputFiles.length !== 1) refused();
  assertFleetConnectorBundleImportsV1(output.metafile);
  const bytes = Buffer.from(output.outputFiles[0].contents);
  const file = `connector-${version}.mjs`;
  const manifest = Object.freeze({ schema: RELEASE_SCHEMA, version, file,
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, builtFrom: commit });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [name, contents] of [[file, bytes], ["manifest.json", manifestBytes]]) {
    const target = join(root, name), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await rename(temporary, target);
  }
  const written = await stat(join(root, file));
  if (written.size !== manifest.size) refused();
  return Object.freeze({ root, manifest });
}

function parse(args) {
  const values = { allowRealHome: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--i-am-the-installer") values.allowRealHome = true;
    else if (args[index] === "--root") values.root = resolve(args[++index] ?? "");
    else if (args[index] === "--built-from") values.builtFrom = args[++index];
    else refused();
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildFleetConnectorReleaseV1(parse(process.argv.slice(2)))
    .then(value => process.stdout.write(`${JSON.stringify(value.manifest)}\n`))
    .catch(() => { process.stderr.write("Control Room connector build refused.\n"); process.exitCode = 1; });
}

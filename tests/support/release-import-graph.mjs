import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { CORE_SERVICE_ROLES_V1, SERVICE_BATCH_ROLES_V1, composeServiceBundleV1 } from "../../src/updater/v1/services/bundle.mjs";
import { taskHostCommand } from "../../scripts/mac-local/stack.mjs";

// Start with the actual service program arguments and the supervisor's actual
// child command. The policy's list of copied files never defines this proof.
export function releaseProgramsV1(root) {
  const account = (name, uid) => ({ name, uid, gid: uid, created: true });
  const accounts = { builder: account("_crbuild", 300), database: account("_crdb", 301), service: account("_controlroom", 302) };
  const current = join(root, "current");
  const resources = SERVICE_BATCH_ROLES_V1.flatMap(roles => composeServiceBundleV1({ root, accounts, roles,
    protectedConfig: roles === CORE_SERVICE_ROLES_V1 ? ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json", "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"].map(name => ({ path: join(root, "Protected/config", name), contents: '{}\n', accountName: accounts.service.name, groupName: accounts.service.name, fileMode: "0600" })).concat({ path: join(root, "updater-state/updater.json"), contents: '{}\n', accountName: "root", groupName: "wheel", fileMode: "0600" }) : [],
    pgRuntime: join(root, "runtime/pg-current/bin/postgres"), updaterVersion: "1.2.3-proof" }).resources);
  const programs = new Set(resources.filter(value => value.kind === "launchd_plist").flatMap(value => {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(value.contents)?.[1] ?? "";
    return [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(match => match[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
  }).filter(path => path.startsWith(current + sep)).map(path => relative(current, path)));
  programs.add(taskHostCommand(root)[1]);
  assert.ok(programs.size >= 4);
  return [...programs];
}

export async function requiredReleaseFilesV1(source, programs) {
  const required = new Set();
  async function visit(name) {
    if (required.has(name)) return;
    assert.ok(!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`), "release import escaped its root");
    required.add(name);
    const text = await readFile(join(source, name), "utf8");
    if (!/\.[cm]?js$/u.test(name)) return;
    const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const variables = new Map(), dependencies = new Set();
    const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
    walk(ast, node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer); });
    function value(node, seen = new Set()) {
      if (!node) return;
      if (ts.isStringLiteralLike(node)) return node.text;
      if (node.getText(ast) === "import.meta.url") return pathToFileURL(join(source, name)).href;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "href") return value(node.expression, seen);
      if (ts.isIdentifier(node) && !seen.has(node.text)) { seen.add(node.text); return value(variables.get(node.text), seen); }
      if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL") {
        const local = value(node.arguments?.[0], new Set(seen)), base = value(node.arguments?.[1], new Set(seen));
        if (local !== undefined && base !== undefined) return new URL(local, base).href;
      }
    }
    function add(specifier) {
      if (specifier === undefined || isBuiltin(specifier)) return;
      if (specifier.startsWith("file:")) dependencies.add(relative(source, fileURLToPath(specifier)));
      else if (specifier.startsWith(".")) dependencies.add(relative(source, resolve(dirname(join(source, name)), specifier)));
      else assert.fail(`release import requires an unshipped package: ${specifier}`);
    }
    walk(ast, node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(value(node.moduleSpecifier));
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(value(node.arguments[0]));
      // URL-based lazy loaders and Worker entry points are part of the graph too.
      if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL") {
        const url = value(node); if (url?.startsWith("file:") && /\.[cm]?js$/u.test(new URL(url).pathname)) add(url);
      }
    });
    for (const dependency of dependencies) await visit(dependency);
  }
  for (const program of programs) await visit(program);
  return [...required].sort();
}

export async function assertReleaseImportGraphV1(source, shipped, programs) {
  const required = await requiredReleaseFilesV1(source, programs);
  for (const name of required) await access(join(shipped, name)).catch(() => assert.fail(`release dependency missing: ${name}`));
  return required;
}

/**
 * Every `.mjs` the release SHIPS under `scripts/`, `deploy/` and `src/installer/`,
 * read from the policy itself so the guard cannot check a different set than the
 * one that was assembled.
 */
export async function shippedReleaseEntryPointsV1(shipped) {
  const found = [];
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) assert.fail(`release entry scan found a symlink: ${path}`);
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, relativeName);
      else if (entry.name.endsWith(".mjs")) found.push(relativeName);
    }
  };
  for (const directory of SHIPPED_ENTRY_DIRECTORIES_V1) await walk(join(shipped, directory), directory);
  return found.sort();
}

// The three directories whose `.mjs` files are programs the release ships. `dist-vps`
// is deliberately not here: it is compiled output, loaded through its own
// `releaseProgramsV1` closure by the launchd guard instead.
export const SHIPPED_ENTRY_DIRECTORIES_V1 = Object.freeze(["scripts", "deploy", "src/installer"]);
// File descriptor 3 is the guard's answer channel (see below): stdout belongs to the
// shipped programs, which print their usage on import.
const GUARD_FD = 3;

/**
 * Imports every shipped `.mjs` entry point, in a CHILD process, from the staged
 * release. A child (not an in-process `import`) is the honest shape: it resolves
 * modules from the staged tree's own `node_modules`, reports one failure per file
 * instead of poisoning the test process, and exercises the same bare `node` an
 * installed release would be started with.
 *
 * The caller prepares the runtime packages (`prepare-local-production-dependencies`
 * runs `pnpm install --prod`), so this guard REFUSES when the staged tree has no
 * `node_modules` instead of pretending the question does not arise.
 */
export async function assertShippedReleaseEntryPointsLoadV1(shipped, { cwd = shipped } = {}) {
  const entryPoints = await shippedReleaseEntryPointsV1(shipped);
  assert.ok(entryPoints.length >= 30, `expected the whole shipped program surface, found ${entryPoints.length}`);
  await access(join(shipped, "node_modules")).catch(error => {
    assert.fail(`the staged release has no prepared node_modules (${error?.code ?? "missing"}): `
      + "its programs cannot be asked to load without the packages prepare-local-production-dependencies installs");
  });
  // Absolute file URLs, computed here rather than in the child, so the child never
  // has to reason about a base path.
  const pairs = entryPoints.map(name => [name, pathToFileURL(join(shipped, name)).href]);
  // The programs are real entry points and several print their usage on import, so
  // the child answers on a FILE-DESCRIPTOR channel rather than stdout or stderr. A
  // child that died before answering leaves that channel EMPTY, which is asserted.
  const script = `
    import { writeSync } from "node:fs";
    const failures = [];
    for (const [name, url] of ${JSON.stringify(pairs)}) {
      try { await import(url); }
      catch (error) { failures.push([name, String(error?.code ?? "unknown"),
        String(error?.message ?? "").split("\\n")[0]]); }
    }
    writeSync(${GUARD_FD}, JSON.stringify({ failures }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script],
    { cwd, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let answer = "";
  child.stdio[GUARD_FD].setEncoding("utf8");
  child.stdio[GUARD_FD].on("data", chunk => { answer += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.notEqual(answer, "", `the load child exited ${code} without answering`);
  const { failures } = JSON.parse(answer);
  // The child's own EXIT CODE is not asserted: importing a shipped CLI can leave
  // `process.exitCode` set (several print usage and exit 2 on import). The answer on
  // the dedicated descriptor is the signal.
  // Named, bounded: a release that ships 40 broken programs should read as a list of
  // the first few, not a wall of paths.
  assert.deepEqual(failures.slice(0, 6), [], failures.length > 6
    ? `${failures.length} shipped programs cannot start, including: `
      + failures.slice(0, 6).map(([name, failureCode, message]) => `${name}: ${failureCode} ${message.split("/").at(-1)}`).join("; ")
    : "every shipped program must start from the assembled release: "
      + failures.map(([name, failureCode, message]) => `${name}: ${failureCode} ${message.split("/").at(-1)}`).join("; "));
  return { entryPoints };
}

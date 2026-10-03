import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";

// R4U-01: scan the emitted browser graph, including nested chunks. Free Node
// names survive minification. Match all Buffer uses, all process members and
// require calls; restrict node: matches to module specifiers to avoid domain IDs.
const NODE_ONLY_PATTERNS = Object.freeze([
  { name: "Buffer", pattern: /\bBuffer\b/g },
  { name: "process", pattern: /\bprocess\s*\./g },
  { name: "require", pattern: /\brequire\s*\(/g },
  { name: "node: specifier", pattern: /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["'`]node:[^"'`]+["'`]/g },
]);

function listJsFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) stack.push(path);
      else if (entry.endsWith(".js")) files.push(path);
    }
  }
  return files;
}

/** Scans every built client `.js` file for Node-only globals unreachable in a real browser. */
export function findClientBundleNodeGlobals(clientRoot) {
  const matches = [];
  const files = listJsFiles(clientRoot);
  if (files.length === 0) throw new Error("client_bundle_missing_javascript");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { name, pattern } of NODE_ONLY_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) matches.push({ file, name });
    }
  }
  return matches;
}

export function main(clientRoot = "dist-vps/client") {
  const matches = findClientBundleNodeGlobals(clientRoot);
  if (matches.length === 0) {
    console.log(`client bundle browser-safety check passed (${clientRoot})`);
    return;
  }
  for (const match of matches) {
    console.error(`${match.file}: references Node-only global ${match.name}`);
  }
  process.exitCode = 1;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();

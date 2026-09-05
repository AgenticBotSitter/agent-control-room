import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

test("only the unwired native HTTPS module owns its network imports; no application imports this adapter", async () => {
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name))
      : Promise.resolve(/\.(?:tsx?|mts|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : [])))).flat();
  }
  const owners = new Set<string>(), consumers: string[] = [];
  for (const path of [...await files("src"), ...await files("app"), ...await files("private-app"), ...await files("packages")]) {
    const source = await readFile(path, "utf8"), normalized = path.replaceAll("\\", "/");
    const inside = normalized.startsWith("src/harness/hermes-native-v1/");
    if (!inside && /(?:hermes-native-v1|createNativeHttpsTransport|HermesNativeRunAdapter|SqliteNativeRunJournal)/.test(source)) consumers.push(normalized);
    if (!inside) continue;
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly
        && ["node:https", "node:tls", "node:dns/promises"].includes(node.moduleSpecifier.text)) owners.add(normalized);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.doesNotMatch(source, /process\.env|child_process|private-loopback-physical-native-driver|\.listen\s*\(|createServer\s*\(|fetch\s*\(/);
  }
  assert.deepEqual([...owners], ["src/harness/hermes-native-v1/https-transport.ts"]);
  assert.deepEqual(consumers, []);
});

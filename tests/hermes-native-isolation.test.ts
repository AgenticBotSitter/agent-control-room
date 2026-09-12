import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

test("native HTTPS imports stay isolated and only the accepted node bridge consumes runtime types and contracts", async () => {
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name))
      : Promise.resolve(/\.(?:tsx?|mts|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : [])))).flat();
  }
  // The shipped node needs exactly one place that assembles durable resources. That role is
  // narrower than "may import anything": it is pinned to the declared vps build entry below.
  const compositionRoots = ["src/node-bridge/private-native-configuration.ts", "src/node-bridge/private-node-entry.ts"];
  const owners = new Set<string>(), consumers: string[] = [], roots: string[] = [];
  for (const path of [...await files("src"), ...await files("app"), ...await files("private-app"), ...await files("packages")]) {
    const source = await readFile(path, "utf8"), normalized = path.replaceAll("\\", "/");
    const inside = normalized.startsWith("src/harness/hermes-native-v1/");
    if (!inside && /(?:hermes-native-v1|createNativeHttpsTransport|HermesNativeRunAdapter|SqliteNativeRunJournal)/.test(source))
      (compositionRoots.includes(normalized) ? roots : consumers).push(normalized);
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
  assert.deepEqual(consumers.sort(), ["src/node-bridge/native-connector.ts", "src/node-bridge/native-http-host.ts"]);
  assert.deepEqual(roots.sort(), [...compositionRoots].sort(), "resource assembly must not spread beyond the pinned composition root");

  // The composition root exists only because the launcher loads a compiled entry. Tie it to that
  // entry so a second assembly point cannot appear without also changing the build definition.
  const vps = await readFile("vite.vps.config.ts", "utf8");
  assert.match(vps, /nodeConnector:\s*"src\/node-bridge\/private-node-entry\.ts"/);
  for (const path of roots) assert.doesNotMatch(await readFile(path, "utf8"),
    /process\.env|child_process|private-loopback-physical-native-driver|\.listen\s*\(|createServer\s*\(|fetch\s*\(/);

  // Constructing native transports and journals stays inside the composition root; consumers
  // receive a supplied runtime instead of building one.
  for (const path of consumers) assert.doesNotMatch(await readFile(path, "utf8"),
    /createNativeHttpsTransport\s*\(|new\s+SqliteNativeRunJournal\s*\(/);
  // CR14C connector acceptance permits supplied runtime ownership, not constructing
  // an adapter, journal or native transport from application code.
  for (const path of consumers) {
    const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.includes("hermes-native-v1")) continue;
      const specifier = statement.moduleSpecifier.text;
      imports.push(specifier);
      if (specifier.endsWith("/node-runtime")) assert.equal(statement.importClause?.isTypeOnly, true);
      else {
        assert.equal(path, "src/node-bridge/native-connector.ts");
        assert.equal(specifier, "../harness/hermes-native-v1/contracts");
        const bindings = statement.importClause?.namedBindings;
        assert.ok(bindings && ts.isNamedImports(bindings));
        assert.deepEqual(bindings.elements.filter(element => !element.isTypeOnly).map(element => element.name.text).sort(),
          ["snapshotSchema", "terminalNativeState"]);
      }
    }
    assert.ok(imports.includes("../harness/hermes-native-v1/node-runtime"));
  }
});

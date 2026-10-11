// Independent CR-E081 oracle: literal names captured from the base revision,
// approved eight-file allocation and unchanged 240000ms package budget.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const partitions = {
  "tests/attack-kit-real-postgres.test.ts": [
    "withRealPostgres cleans up after a thrown error",
    "withRealPostgres refuses an occupied port instead of reusing a foreign cluster",
    "hands out connections as named production roles and enforces their grants",
    "does not touch a port it was not given",
    "refuses a missing or empty allowlist before probing anything"
  ],
  "tests/attack-kit-shutdown-real-postgres.test.ts": [
    "a failed pid read after a real start leaves no postmaster behind",
    "an unconfirmed shutdown preserves the data directory and fails the run",
    "a start that fails after launching a postmaster leaves nothing behind"
  ],
  "tests/attack-kit-role-refusal-real-postgres.test.ts": [
    "roleCannot catches a role that was wrongly granted",
    "isPrivilegeDenied distinguishes a refusal from any other error",
    "isPrivilegeDenied accepts 42501 only",
    "roleCannot rejects a refusal that is not a privilege refusal"
  ],
  "tests/attack-kit-search-path-gate-real-postgres.test.ts": [
    "the gate passes on the real migrations, and fails on every attack scenario",
    "an allowlisted routine passes the gate until its expiry"
  ],
  "tests/attack-kit-search-path-waiver-real-postgres.test.ts": [
    "a later migration that changes a waived routine's search_path fails the gate",
    "the gate refuses a database whose migrations were never applied"
  ],
  "tests/bounded-usage-read-postgres.test.ts": [
    "the task-detail usage read stays bounded and exact across 5,000 runs of a real job",
    "runs whose harness reported tokens but omitted the cache key still price"
  ],
  "tests/bounded-usage-pricing-postgres.test.ts": [
    "the usage aggregate never merges two runs that price differently",
    "the usage aggregate reports the same evidence precedence the per-run path does"
  ],
  "tests/bounded-usage-attempts-postgres.test.ts": [
    "the per-attempt rollup read stays bounded when a job has more attempts than the page shows"
  ]
};
const read = path => {
  assert.ok(existsSync(new URL(path, new URL("../", import.meta.url))), `required partition exists: ${path}`);
  return readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");
};
// Closed preservation language, not arbitrary JavaScript execution analysis.
// The complete reviewed programs at 9c8ab635 provide independent syntax seals.
// Imports, bindings, operators, control flow, bodies and closure obligations are
// retained. Only trivia, quote spelling and inert module string prefixes vary.
// New executable shapes need independent review and a new captured contract;
// never regenerate these values from the source currently being checked.
const seals = {
  "tests/attack-kit-real-postgres.test.ts": {
    "allocation": "cb96139fbb67cb65580aa8607f4475835e93717b4fc1e19db485725598c1f8fd",
    "complete": "471c20cf4e4eec17c6b105af3cb476ed5201e1554536257e3244fcc61ee9b2f0"
  },
  "tests/attack-kit-shutdown-real-postgres.test.ts": {
    "allocation": "57e76714faed2c06cbee27a4b2d7cea1b232281a666f8d77d77ae27fa13d0c27",
    "complete": "4cf2f1dfd763fedc98b8349ad475e65bd1cb48124f68ae8956b986ae5456175a"
  },
  "tests/attack-kit-role-refusal-real-postgres.test.ts": {
    "allocation": "40d3f458002197fcbafe8900e5677abc86c79902ffda43eed41504c57fc4f05c",
    "complete": "70e4c8ffc4ac7f34566e5658ffce19625506a52cd25a44c4e0373d0bd79c34e2"
  },
  "tests/attack-kit-search-path-gate-real-postgres.test.ts": {
    "allocation": "a72dea9f9685885c61e4d5f955d904980f64deafec45bc96c8bebe668249c830",
    "complete": "40801c60ac3a7d3c36d150c2c366ba02015b5a5e384ff0d91df4d0518186281a"
  },
  "tests/attack-kit-search-path-waiver-real-postgres.test.ts": {
    "allocation": "6d5c4236bfabe2174129bc3159e9b8c1ea45e4cd09c562d178dd9b6c6a8e21b3",
    "complete": "2a9a16b66c50844dd12abf1f63ed35c9c826930058a1528a92b712725a85f83b"
  },
  "tests/bounded-usage-read-postgres.test.ts": {
    "allocation": "880f8a653899dd8e97521502a367a8fc860dbaa7f1663ba2da8aaad275a99242",
    "complete": "435d709e41ce2c75db93c2b71004a2f807066800d854c7f17c212f9042daeb20"
  },
  "tests/bounded-usage-pricing-postgres.test.ts": {
    "allocation": "e6d03a3ad4f1486604963db2cf038fae6f621885ef853816f98aaa90b84d2ff0",
    "complete": "215c7510ce2c176c0fbb2280304aad5e1566986cb87aa13ac4b64c0930a98541"
  },
  "tests/bounded-usage-attempts-postgres.test.ts": {
    "allocation": "ef0aaa611cdacd8760d5fb6000b7cac02fd95a9669cd8f03f1fb4e40985e3eac",
    "complete": "695e140f79785c363498c3c54e5b8a2e8db82675ad43266c12b63b1c70f8daff"
  },
  "tests/support/attack-kit/suite-lane.ts": {
    "complete": "3470b35e4a4ffbe6c161770988508cc9f5ecbd15e7ae0dc997b4f4de392d59f5"
  },
  "tests/support/bounded-usage-fixture.ts": {
    "complete": "40850cda758c06d5f7f2024d6f10b3726ede3cb67e45e2c49c014942423fb8dc"
  }
};
const parse = source => ts.createSourceFile("partition.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const isCall = (node, name) => Boolean(node) && ts.isCallExpression(node) && node.expression.getText() === name;
const callback = node => Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
const inert = node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression);
const shape = node => {
  const children = node.getChildren();
  return [ts.SyntaxKind[node.kind], children.length ? children.map(shape)
    : ts.isStringLiteral(node) ? node.text : node.getText()];
};
const digest = nodes => createHash("sha256").update(JSON.stringify(nodes.filter(node => !inert(node)).map(shape))).digest("hex");
const closing = (statement, wanted) => ts.isExpressionStatement(statement)
  && (isCall(statement.expression, "lane.closeLane")
    || (isCall(statement.expression, "test") && !wanted.includes(statement.expression.arguments[0]?.text)));
const preserved = (source, path, allocation = false) => {
  const tree = parse(source);
  if (tree.parseDiagnostics.length) return false;
  const nodes = [...tree.statements].filter(statement => !allocation || !closing(statement, partitions[path]));
  return digest(nodes) === seals[path][allocation ? "allocation" : "complete"];
};
// Extraction only supplies diagnostics after the complete binding/execution
// program has been sealed. Identifier spelling alone never authorizes success.
const registrations = source => {
  const calls = [];
  const visit = statements => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement)) continue;
      const call = statement.expression;
      if (isCall(call, "test")) calls.push(call);
      else if (isCall(call, "describe") && callback(call.arguments[1]) && ts.isBlock(call.arguments[1].body))
        visit(call.arguments[1].body.statements);
    }
  };
  visit(source.statements);
  return calls;
};
const names = source => registrations(parse(source)).map(call => call.arguments[0]?.text);

const completedBodies = (tree, wanted) => {
  const bodies = registrations(tree).filter(call => wanted.includes(call.arguments[0]?.text));
  const completed = bodies.filter(call => {
    const statements = call.arguments.at(-1)?.body?.statements;
    const last = statements?.at(-1);
    const previous = statements?.at(-2);
    return last && ts.isExpressionStatement(last) && ts.isBinaryExpression(last.expression)
      && last.expression.left.getText() === "completed" && last.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      && last.expression.right.getText() === "1" && previous && ts.isExpressionStatement(previous)
      && ts.isAwaitExpression(previous.expression) && isCall(previous.expression.expression, "withRealPostgres");
  });
  return completed.length;
};

test("CR-E081 conserves every original feature name exactly once in its partition", () => {
  const expected = Object.values(partitions).flat().sort();
  const actual = Object.entries(partitions).flatMap(([path, wanted]) => {
    const source = read(path);
    const found = preserved(source, path, true) ? names(source).filter(name => expected.includes(name)) : [];
    assert.deepEqual(found, wanted, `feature allocation for ${path}`);
    return found;
  }).sort();
  assert.deepEqual(actual, expected, "all 21 original feature names occur exactly once");
});

test("CR-E081 routes all eight partitions through the package lane and example", () => {
  const command = JSON.parse(read("package.json")).scripts["test:attack-kit"];
  const example = JSON.parse(read("scripts/test-runner/config.example.json"));
  // The example carries script commands in its allowedScripts map.
  assert.equal(example.allowedScripts["test:attack-kit"], command, "example mirrors the exact package command");
  const files = command.split(/\s+/u).filter(word => word.startsWith("tests/"));
  for (const path of [...Object.keys(partitions), "tests/attack-kit-lane-partitions.test.mjs"])
    assert.equal(files.filter(file => file === path).length, 1, `lane routes ${path} exactly once`);
});

test("CR-E081 retains file budgets and each partition's closing checks", () => {
  const command = JSON.parse(read("package.json")).scripts["test:attack-kit"];
  assert.match(command, /--test-timeout=240000(?:\s|$)/u, "the file timeout remains 240000ms");
  assert.match(command, /--test-concurrency=1(?:\s|$)/u, "cluster files remain serial");
  for (const [path, wanted] of Object.entries(partitions)) {
    const source = read(path);
    const tree = parse(source);
    if (path.includes("attack-kit-")) {
      const lanes = tree.statements.filter(statement => ts.isVariableStatement(statement)).flatMap(statement => [...statement.declarationList.declarations])
        .filter(declaration => declaration.name.getText() === "lane" && declaration.initializer && ts.isAwaitExpression(declaration.initializer) && isCall(declaration.initializer.expression, "createLane"));
      assert.equal(lanes.length, 1, `own lane: ${path}`);
      const closes = tree.statements.filter(statement => ts.isExpressionStatement(statement) && isCall(statement.expression, "lane.closeLane"));
      assert.equal(closes.length, 1, `closing integrity checks: ${path}`);
      const prefixes = closes[0].expression.arguments[0];
      assert.ok(prefixes && ts.isArrayLiteralExpression(prefixes) && prefixes.elements.every(ts.isStringLiteral), `literal closing prefixes: ${path}`);
      for (const prefix of new Set(["attack-kit-pg-", ...[...source.matchAll(/temporary\("([^"\n]+)"/gu)].map(match => match[1])]))
        assert.ok(prefixes.elements.some(element => element.text === prefix), `closing prefix ${prefix}: ${path}`);
    } else {
      assert.equal(completedBodies(tree, wanted), wanted.length, `completed bodies: ${path}`);
      const guards = registrations(tree).filter(call => !wanted.includes(call.arguments[0]?.text));
      assert.equal(guards.length, 1, `own completion check: ${path}`);
      const assertions = guards[0]?.arguments.at(-1)?.body?.statements?.filter(statement => ts.isExpressionStatement(statement) && isCall(statement.expression, "assert.equal")) ?? [];
      assert.ok(assertions.some(statement => {
        const args = statement.expression.arguments;
        return args.length === 3 && args[0].getText() === "completed" && ts.isNumericLiteral(args[1]) && args[1].text === String(wanted.length)
          && ts.isStringLiteral(args[2]) && args[2].text === "a required-but-skipped cluster test must fail the run";
      }), `completion guard: ${path}`);
      assert.equal([...source.matchAll(/boundMs: 240_000/gu)].length, wanted.length, `unchanged body bounds: ${path}`);
    }
    assert.ok(preserved(source, path), `${path.includes("attack-kit-") ? "closing integrity checks" : "completion guard"}: ${path}`);
    assert.ok(source.includes("PG_BIN"), `affected-test PG routing: ${path}`);
  }
  const fixture = read("tests/support/bounded-usage-fixture.ts");
  assert.ok(preserved(fixture, "tests/support/bounded-usage-fixture.ts"), "importing fixtures registers no tests");
  assert.ok(preserved(read("tests/support/attack-kit/suite-lane.ts"), "tests/support/attack-kit/suite-lane.ts"), "actual lane closure bindings and assertions");
  // Deterministic finite grammar: independent decisions are literal true/false,
  // not values computed by the recognizer. The seed is retained in each label.
  const featurePath = "tests/attack-kit-real-postgres.test.ts";
  const feature = read(featurePath);
  for (let seed = 0; seed < 16; seed += 1) {
    const prefix = `${" ".repeat(seed)}// inert seed ${seed}: test.skip()\n"test('inert prefix')";\n`;
    const positive = prefix + (seed % 2 ? feature.replace('from "node:test"', "from 'node:test'") : feature);
    assert.equal(preserved(positive, featurePath, true), true, `supported source grammar seed ${seed}`);
    const negative = positive.replace('describe("attack kit: real PostgreSQL", () => {',
      'describe("attack kit: real PostgreSQL", () => { return;');
    assert.equal(preserved(negative, featurePath, true), false, `unreachable source grammar seed ${seed}`);
  }
  const usagePath = "tests/bounded-usage-read-postgres.test.ts";
  assert.equal(preserved(feature + "\n}", featurePath, true), false, "malformed source grammar refuses parser recovery");
  assert.equal(completedBodies(parse(read(usagePath).replace("  completed += 1;", "  // completed += 1;")), partitions[usagePath]), 1,
    "completed-body recognition excludes commented increments");
  assert.equal(completedBodies(parse(read(usagePath).replace("  completed += 1;", "  return; completed += 1;")), partitions[usagePath]), 1,
    "completed-body recognition requires adjacent awaited producer");

  assert.equal(preserved(read(usagePath).replace("  if (!PG) return;", "  return;"), usagePath), false,
    "closing seal refuses unreachable completion assertion");
  assert.equal(preserved("import { test as register } from 'node:test';\n" + fixture,
    "tests/support/bounded-usage-fixture.ts"), false, "fixture seal refuses aliased registration import");
  const helperPath = "tests/support/attack-kit/suite-lane.ts";
  assert.equal(preserved(read(helperPath).replace("assert.equal(realPostgresRan, realPostgresRequired,",
    "assert.equal(realPostgresRan, realPostgresRan,"), helperPath), false, "helper seal refuses self-comparing completion");

});

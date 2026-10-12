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

// Diagnostics consume literal syntax only. Complete seals remain the authority.
const syntaxNodes = (tree, predicate) => {
  const found = [];
  const visit = node => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};
const temporaryPrefixes = tree => syntaxNodes(tree, node => isCall(node, "temporary")
  && ts.isStringLiteral(node.arguments[0])).map(node => node.arguments[0].text);
const bodyBounds = tree => syntaxNodes(tree, node => ts.isPropertyAssignment(node)
  && node.name.getText() === "boundMs" && ts.isNumericLiteral(node.initializer)
  && Number(node.initializer.text) === 240_000).length;
// Bind the witness to the parsed executable block, never its quote/trivia spelling.
const unreachableSuite = (source, insertion = " return;") => {
  const suite = parse(source).statements.find(statement => ts.isExpressionStatement(statement)
    && isCall(statement.expression, "describe"));
  const block = suite.expression.arguments[1].body;
  const at = block.getStart() + 1;
  const mutant = source.slice(0, at) + insertion + source.slice(at);
  assert.notEqual(mutant, source, "suite witness changes source bytes");
  assert.ok(ts.isReturnStatement(parse(mutant).statements.find(statement => ts.isExpressionStatement(statement)
    && isCall(statement.expression, "describe")).expression.arguments[1].body.statements[0]),
  "suite witness inserts reachable return");
  return mutant;
};
const changed = (source, find, replacement) => {
  const mutant = source.replace(find, () => replacement);
  assert.notEqual(mutant, source, `literal witness changes source: ${find}`);
  return mutant;
};

const replaceNode = (source, node, replacement) => changed(source, source,
  source.slice(0, node.getStart()) + replacement + source.slice(node.end));
const completionWitness = (source, replacement) => replaceNode(source,
  syntaxNodes(parse(source), node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
    && node.expression.left.getText() === "completed")[0], replacement);
const guardWitness = source => replaceNode(source,
  syntaxNodes(parse(source), node => ts.isIfStatement(node) && ts.isPrefixUnaryExpression(node.expression)
    && node.expression.operand.getText() === "PG")[0], "return;");
const helperWitness = source => replaceNode(source,
  syntaxNodes(parse(source), node => isCall(node, "assert.equal")
    && node.arguments[1]?.getText() === "realPostgresRequired")[0].arguments[1], "realPostgresRan");

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
      for (const prefix of new Set(["attack-kit-pg-", ...temporaryPrefixes(tree)]))
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
      assert.equal(bodyBounds(tree), wanted.length, `unchanged body bounds: ${path}`);
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
    const negative = unreachableSuite(positive);
    assert.equal(preserved(negative, featurePath, true), false, `unreachable source grammar seed ${seed}`);
  }
  const usagePath = "tests/bounded-usage-read-postgres.test.ts";
  assert.equal(preserved(feature + "\n}", featurePath, true), false, "malformed source grammar refuses parser recovery");
  assert.equal(completedBodies(parse(completionWitness(read(usagePath), "// completed += 1;")), partitions[usagePath]), 1,
    "completed-body recognition excludes commented increments");
  assert.equal(completedBodies(parse(completionWitness(read(usagePath), "return; completed += 1;")), partitions[usagePath]), 1,
    "completed-body recognition requires adjacent awaited producer");

  assert.equal(preserved(guardWitness(read(usagePath)), usagePath), false,
    "closing seal refuses unreachable completion assertion");
  assert.equal(preserved("import { test as register } from 'node:test';\n" + fixture,
    "tests/support/bounded-usage-fixture.ts"), false, "fixture seal refuses aliased registration import");
  const helperPath = "tests/support/attack-kit/suite-lane.ts";
  assert.equal(preserved(helperWitness(read(helperPath)), helperPath), false, "helper seal refuses self-comparing completion");

});

test("CR-E081 supported trivia keeps diagnostics and executable witnesses exact", () => {
  const path = "tests/attack-kit-real-postgres.test.ts";
  const source = read(path);
  const suite = parse(source).statements.find(statement => ts.isExpressionStatement(statement)
    && isCall(statement.expression, "describe"));
  const header = source.slice(suite.getStart(), suite.expression.arguments[1].body.getStart() + 1);
  const variant = replacement => changed(source, header, "/* supported variant */ " + replacement);
  assert.throws(() => changed(source, "absent witness anchor", "return;"),
    /literal witness changes source/u, "literal witness refuses unchanged bytes");
  assert.throws(() => unreachableSuite(source, ""), /suite witness changes source bytes/u,
    "suite witness refuses unchanged bytes");
  assert.throws(() => unreachableSuite(source, ";"), /suite witness inserts reachable return/u,
    "suite witness refuses non-return insertion");
  assert.deepEqual(temporaryPrefixes(parse('temporary("literal-"); temporary(alias); other("other-"); // temporary("comment-")')),
    ["literal-"], "prefix diagnostics require literal syntax");
  assert.equal(bodyBounds(parse('const boundMs = 240000; const options = { otherMs: 240000, boundMs: "240000", boundMs: 239999 };')), 0,
    "bounds diagnostics refuse strings and other values");
  const variants = [
    variant("describe('attack kit: real PostgreSQL', () => {"),
    variant('describe("attack kit: real PostgreSQL", /* inert */ () => {'),
    variant('describe("attack kit: real PostgreSQL", ()  =>  {'),
    changed(source, source, '// temporary("phantom-comment-")\n' + source),
    variant("describe( /* alias text: register */ 'attack kit: real PostgreSQL', () /* trivia */ => {"),
    variant('describe(\n"attack kit: real PostgreSQL",\n() => /* block */ {'),
    variant('describe("attack kit: real PostgreSQL", ( /* alias text: test */ )=>{')
  ];
  for (const [index, positive] of variants.entries()) {
    assert.equal(preserved(positive, path, true), true, `supported trivia allocation ${index}`);
    assert.equal(preserved(positive, path), true, `supported trivia complete seal ${index}`);
    assert.deepEqual(temporaryPrefixes(parse(positive)), ["attack-kit-foreign-"],
      `literal prefixes ignore comment text ${index}`);
    assert.equal(preserved(unreachableSuite(positive), path, true), false, `supported trivia negative ${index}`);
  }
  const usagePath = "tests/bounded-usage-read-postgres.test.ts";
  const usage = read(usagePath);
  for (const [index, spelling] of ["boundMs:  240_000", "boundMs: /* bound */ 240_000", "boundMs:\n240_000"].entries()) {
    const bound = syntaxNodes(parse(usage), node => ts.isPropertyAssignment(node) && node.name.getText() === "boundMs")[0];
    const positive = replaceNode(usage, bound, "/* supported bound variant */ " + spelling);
    assert.equal(preserved(positive, usagePath), true, `supported bound spacing ${index}`);
    assert.equal(bodyBounds(parse(positive)), 2, `literal bounds ignore trivia ${index}`);
    const changedBound = syntaxNodes(parse(positive), node => ts.isPropertyAssignment(node) && node.name.getText() === "boundMs")[0];
    const negative = replaceNode(positive, changedBound, "boundMs: 239_999");
    assert.equal(bodyBounds(parse(negative)), 1, `literal bounds reject changed value ${index}`);
    assert.equal(preserved(negative, usagePath), false, `bound seal refuses changed value ${index}`);
  }
});


test("CR-E081 source witnesses preserve literal dollar metasyntax", () => {
  // Independent byte oracles: hand-written source pairs, frozen before repair.
  // Both spellings are in the supported JS/TS language; no manifest supplies expectations.
  const spellings = [
    ["JavaScript", "const total = 1;\n", "const total = 2;\n"],
    ["TypeScript", "const total: number = 1;\n", "const total: number = 2;\n"]
  ];
  const prefixes = [
    ["line match", "// literal $&\n"],
    ["line before", "// literal $`\n"],
    ["line after", "// literal $'\n"],
    ["line dollar", "// literal $$\n"],
    ["block match", "/* literal $& */\n"],
    ["block before", "/* literal $` */\n"],
    ["block after", "/* literal $' */\n"],
    ["block dollar", "/* literal $$ */\n"],
    ["inert match", '"literal $&";\n'],
    ["inert before", '"literal $`";\n'],
    ["inert after", '"literal $\'";\n'],
    ["inert dollar", '"literal $$";\n']
  ];
  const path = "tests/attack-kit-real-postgres.test.ts";
  const captured = read(path); // sealed independently by the unchanged captured program hashes
  for (const [language, before, after] of spellings) {
    for (const [label, prefix] of prefixes) {
      const source = prefix + before;
      const expected = prefix + after;
      const numeric = syntaxNodes(parse(source), ts.isNumericLiteral)[0];
      assert.equal(replaceNode(source, numeric, "2"), expected,
        `literal node bytes ${language} ${label}`);
      assert.equal(changed(source, source, expected), expected,
        `literal whole-source bytes ${language} ${label}`);
      assert.equal(changed(before, "1", prefix + "2"), "const total" + (language === "TypeScript" ? ": number" : "") + " = " + prefix + "2;\n",
        `literal partial replacement bytes ${language} ${label}`);
      const supported = prefix + captured;
      assert.equal(preserved(supported, path), true, `literal supported source ${language} ${label}`);
      assert.equal(preserved(unreachableSuite(supported), path), false,
        `literal unsafe source ${language} ${label}`);
    }
  }
});

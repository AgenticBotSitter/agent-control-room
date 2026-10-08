import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = resolve(root, 'tests/helpers/block-agent-cli.mjs');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : /\.(?:[cm]?[jt]s|tsx|jsx)$/u.test(extname(path)) ? [path] : [];
  });
}

function unparenthesized(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function member(node, name) {
  node = unparenthesized(node);
  if (ts.isPropertyAccessExpression(node) && node.name.text === name) return node.expression;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === name) return node.expression;
  return undefined;
}

function isGuard(node) {
  const env = member(node, 'CONTROL_ROOM_TEST_BLOCK_AGENT_CLI');
  const processObject = env && member(env, 'env');
  return Boolean(processObject && ts.isIdentifier(unparenthesized(processObject))
    && unparenthesized(processObject).text === 'process');
}

function hasGuardAssertion(parsed) {
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const [actual, expected] = node.arguments.map(unparenthesized);
      const isOne = value => ts.isStringLiteralLike(value) && value.text === '1';
      if ((isGuard(actual) && isOne(expected)) || (isOne(actual) && isGuard(expected))) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

function runtimeDependency(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return false;
    if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.length > 0
      && clause.namedBindings.elements.every(element => element.isTypeOnly)) return false;
    return true;
  }
  return ts.isExportDeclaration(statement) && Boolean(statement.moduleSpecifier) && !statement.isTypeOnly;
}

function violatesGuardPolicy(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (!hasGuardAssertion(parsed)) return false;
  const first = parsed.statements.find(runtimeDependency);
  // A barrel can evaluate the connector too: the helper must precede every runtime dependency.
  return !first || !ts.isImportDeclaration(first) || Boolean(first.importClause)
    || !ts.isStringLiteral(first.moduleSpecifier)
    || resolve(dirname(file), first.moduleSpecifier.text) !== helper;
}

test('load-time agent CLI assertions import the helper before the connector', () => {
  const violations = sourceFiles(join(root, 'tests')).filter(file =>
    violatesGuardPolicy(file, readFileSync(file, 'utf8'))
  ).map(file => relative(root, file).split('\\').join('/')).sort();
  assert.deepEqual(violations, [], `missing or late agent CLI guard helper: ${violations.join(', ')}`);
});

const guardAssertion = "assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '1');";
const helperImport = "import './helpers/block-agent-cli.mjs';";
const connectorImport = "import * as connector from '../scripts/fleet/connector.mjs';";
const fixtureFile = join(root, 'tests/guard-order-fixture.test.ts');

test('guard ordering rejects early exports, barrels and erased helper imports', () => {
  const unsafeDependencies = [
    "export * from '../scripts/fleet/connector.mjs';",
    "export { runCommand } from '../scripts/fleet/connector.mjs';",
    "import './helpers/connector-barrel.mjs';",
    "export * from './helpers/connector-barrel.mjs';",
  ];
  for (const dependency of unsafeDependencies) {
    assert.equal(violatesGuardPolicy(fixtureFile, `${dependency}\n${helperImport}\n${guardAssertion}`),
      true, `must reject dependency before helper: ${dependency}`);
  }
  for (const erased of [
    "import type {} from './helpers/block-agent-cli.mjs';",
    "import type * as guard from './helpers/block-agent-cli.mjs';",
    "export type * from './helpers/block-agent-cli.mjs';",
    "import { type Guard } from './helpers/block-agent-cli.mjs';",
  ]) {
    assert.equal(violatesGuardPolicy(fixtureFile, `${erased}\n${connectorImport}\n${guardAssertion}`),
      true, `must reject erased helper: ${erased}`);
  }
  assert.equal(violatesGuardPolicy(fixtureFile, `${connectorImport}\n${guardAssertion}`), true, 'missing helper');
  assert.equal(violatesGuardPolicy(fixtureFile, `${connectorImport}\n${helperImport}\n${guardAssertion}`), true, 'late helper');
  assert.equal(violatesGuardPolicy(fixtureFile,
    `import * as guard from './helpers/block-agent-cli.mjs';\n${connectorImport}\n${guardAssertion}`),
  true, 'require explicit side-effect helper');
  assert.equal(violatesGuardPolicy(fixtureFile,
    `import type { TypeOnly } from './helpers/unrelated.mjs';\n${helperImport}\n${connectorImport}\n${guardAssertion}`),
  false, 'type-only dependency before runtime helper is safe');
  assert.equal(violatesGuardPolicy(fixtureFile,
    `${helperImport}\nexport * from './helpers/connector-barrel.mjs';\n${guardAssertion}`),
  false, 'helper before runtime export is safe');
  assert.equal(violatesGuardPolicy(fixtureFile,
    `${helperImport}\nawait import('../scripts/fleet/connector.mjs');\n${guardAssertion}`),
  false, 'runtime dynamic import follows static helper evaluation');
});

test('guard assertion selection recognizes equivalent literals and environment access', () => {
  const assertions = [
    `assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, "1");`,
    `assert.equal(process.env['CONTROL_ROOM_TEST_BLOCK_AGENT_CLI'], '1');`,
    `assert.equal(process.env["CONTROL_ROOM_TEST_BLOCK_AGENT_CLI"], "1");`,
    `assert.strictEqual(process['env']['CONTROL_ROOM_TEST_BLOCK_AGENT_CLI'], '1');`,
    "assert.equal((process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI), `1`);",
    "assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '\\x31');",
    "assert.equal('1', process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI);",
    `assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI /* comment */,\n "1");`,
  ];
  for (const assertion of assertions) {
    assert.equal(violatesGuardPolicy(fixtureFile, `${connectorImport}\n${assertion}`), true,
      `must select equivalent guard assertion: ${assertion}`);
    assert.equal(violatesGuardPolicy(fixtureFile, `${helperImport}\n${connectorImport}\n${assertion}`), false,
      `must accept self-contained equivalent guard assertion: ${assertion}`);
  }
  for (const unrelated of ['', '// '+guardAssertion, `const example = ${JSON.stringify(guardAssertion)};`,
    "assert.equal(process.env.OTHER_FLAG, '1');", "assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '0');"]) {
    assert.equal(violatesGuardPolicy(fixtureFile, `${connectorImport}\n${unrelated}`), false,
      `must ignore non-guard source: ${unrelated}`);
  }
});

test('the helper sets the guard in a fresh process and the real reader refuses unstubbed CLIs', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    delete process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI;
    delete process.env.CONTROL_ROOM_TEST_AGENT_CLI_DIR;
    delete process.env.CONTROL_ROOM_TEST_SERVICE_CLI_DIR;
    await import(${JSON.stringify(new URL('./helpers/block-agent-cli.mjs', import.meta.url).href)});
    const { runCommand } = await import(${JSON.stringify(new URL('../scripts/fleet/connector.mjs', import.meta.url).href)});
    const refused = [];
    for (const command of ['claude', 'codex', 'hermes', 'launchctl', 'systemctl', 'schtasks']) {
      try {
        await runCommand(command, [], { spawnProcess() { throw new Error('unexpected spawn'); } });
      } catch (error) { refused.push(error.message); }
    }
    console.log(JSON.stringify({ guard: process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, refused }));
  `], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(output), {
    guard: '1',
    refused: [
      'Test guard refused to spawn the real claude CLI.',
      'Test guard refused to spawn the real codex CLI.',
      'Test guard refused to spawn the real hermes CLI.',
      'Test guard refused to spawn the real launchctl service manager.',
      'Test guard refused to spawn the real systemctl service manager.',
      'Test guard refused to spawn the real schtasks service manager.',
    ],
  });
});

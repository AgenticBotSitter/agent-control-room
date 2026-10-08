import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = resolve(root, 'tests/helpers/block-agent-cli.mjs');
const connector = resolve(root, 'scripts/fleet/connector.mjs');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : /\.(?:[cm]?[jt]s|tsx|jsx)$/u.test(extname(path)) ? [path] : [];
  });
}

test('load-time agent CLI assertions import the helper before the connector', () => {
  const violations = [];
  for (const file of sourceFiles(join(root, 'tests'))) {
    const source = readFileSync(file, 'utf8');
    if (!/process\.env\.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI,\s*'1'/u.test(source)) continue;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = parsed.statements.filter(ts.isImportDeclaration);
    const targets = imports.map(statement => resolve(dirname(file), statement.moduleSpecifier.text));
    const helperIndex = targets.indexOf(helper);
    const connectorIndexes = targets.flatMap((target, index) => target === connector ? [index] : []);
    if (helperIndex === -1 || connectorIndexes.some(index => index < helperIndex)) {
      violations.push(relative(root, file).split('\\').join('/'));
    }
  }
  assert.deepEqual(violations.sort(), [], `missing or late agent CLI guard helper: ${violations.join(', ')}`);
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

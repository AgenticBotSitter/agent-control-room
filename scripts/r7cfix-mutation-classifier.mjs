import { readFileSync } from 'node:fs';
import { isMainModuleV1 } from '../src/installer/shared/is-main-module.mjs';

export const exactTestPattern = name => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

// Parse the Node TAP reporter's top-level results and each result's OWN
// diagnostic mapping. Indented error/stack text cannot supply diagnostic keys.
// Unsupported, duplicate or incomplete evidence fails closed.
export function parseNodeTap(output) {
  const lines = output.split(/\r?\n/);
  const results = [], totals = {};
  if (lines[0] !== 'TAP version 13') throw new Error('missing TAP header');
  let plan;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const result = /^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO)(?: .*)?)?$/.exec(line);
    if (result) {
      const entry = { ok: result[1] === 'ok', number: Number(result[2]), name: result[3], directive: result[4], diagnostic: {} };
      if (entry.number !== results.length + 1 || lines[i - 1] !== `# Subtest: ${entry.name}`) throw new Error('unbound result');
      if (lines[i + 1] === '  ---') {
        let closed = false;
        for (i += 2; i < lines.length; i++) {
          if (lines[i] === '  ...') { closed = true; break; }
          const field = /^  (failureType|code|name): (?:'([^']*)'|"([^"]*)"|([A-Za-z_]+))$/.exec(lines[i]);
          if (field) {
            if (Object.hasOwn(entry.diagnostic, field[1])) throw new Error('duplicate diagnostic');
            entry.diagnostic[field[1]] = field[2] ?? field[3] ?? field[4];
          }
        }
        if (!closed) throw new Error('incomplete diagnostic');
      }
      results.push(entry);
      continue;
    }
    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary) {
      if (Object.hasOwn(totals, summary[1])) throw new Error('duplicate summary');
      totals[summary[1]] = Number(summary[2]);
      continue;
    }
    const end = /^1\.\.(\d+)$/.exec(line);
    if (end) {
      if (plan !== undefined) throw new Error('duplicate plan');
      plan = Number(end[1]);
      continue;
    }
    if (line !== '' && !line.startsWith('#')) throw new Error('unsupported TAP record');
  }
  if (plan !== results.length || totals.tests !== results.length || totals.suites !== 0
      || totals.tests !== totals.pass + totals.fail + totals.cancelled + totals.skipped + totals.todo) {
    throw new Error('incomplete or inconsistent TAP totals');
  }
  return { results, totals };
}

function namedRun(run, name) {
  if (!run || !Number.isInteger(run.status) || ![0, 1].includes(run.status)) throw new Error('abnormal process exit');
  const parsed = parseNodeTap(run.output);
  const matches = parsed.results.filter(result => result.name === name);
  if (matches.length !== 1 || matches[0].directive) throw new Error('named test missing, ambiguous or skipped');
  if (parsed.results.some(result => result.name !== name && (!result.ok || result.directive !== 'SKIP'))
      || parsed.totals.cancelled !== 0 || parsed.totals.todo !== 0) throw new Error('other execution failed or ran');
  return { target: matches[0], totals: parsed.totals };
}

export function passingBaseline(run, name) {
  try {
    const { target, totals } = namedRun(run, name);
    return run.status === 0 && target.ok && totals.pass === 1 && totals.fail === 0
      && !Object.hasOwn(target.diagnostic, 'failureType');
  } catch { return false; }
}

export function classifyMutation({ baseline, mutated, name }) {
  if (!passingBaseline(baseline, name)) return 'HARNESS-ERROR';
  try {
    const { target, totals } = namedRun(mutated, name);
    if (mutated.status === 0 && target.ok && totals.pass === 1 && totals.fail === 0
        && !Object.hasOwn(target.diagnostic, 'failureType')) return 'SURVIVED';
    if (mutated.status === 1 && !target.ok && totals.pass === 0 && totals.fail === 1
        && target.diagnostic.failureType === 'testCodeFailure'
        && target.diagnostic.code === 'ERR_ASSERTION'
        && target.diagnostic.name === 'AssertionError') return 'CAUGHT';
  } catch { /* No positive evidence means no mutation credit. */ }
  return 'HARNESS-ERROR';
}

function main(args) {
  if (args[0] === '--pattern' && args.length === 2) {
    console.log(exactTestPattern(args[1]));
    return;
  }
  if (args[0] === '--baseline' && args.length === 4) {
    const passed = passingBaseline({ output: readFileSync(args[1], 'utf8'), status: Number(args[2]) }, args[3]);
    console.log(passed ? 'BASELINE-PASS' : 'HARNESS-ERROR');
    process.exitCode = passed ? 0 : 1;
    return;
  }
  if (args.length !== 5) throw new Error('usage: classifier <baseline-log> <baseline-status> <mutation-log> <mutation-status> <exact-name>');
  const verdict = classifyMutation({ baseline: { output: readFileSync(args[0], 'utf8'), status: Number(args[1]) },
    mutated: { output: readFileSync(args[2], 'utf8'), status: Number(args[3]) }, name: args[4] });
  console.log(verdict);
  process.exitCode = verdict === 'CAUGHT' ? 0 : 1;
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { console.log('HARNESS-ERROR'); process.exitCode = 1; }
}

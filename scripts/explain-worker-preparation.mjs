import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { checkPrivateWorkerPreparationV1 } from './check-private-worker-preparation.mjs';
import { comparePreparations, explainPreparation } from '../src/worker-preparation-report/v1/explain.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const GENERIC_REFUSAL = 'Control Room worker preparation explanation refused supplied facts.';

async function readBounded(path) {
  const handle = await readFile(resolve(path), 'utf8').catch(() => null);
  return typeof handle === 'string' && Buffer.byteLength(handle, 'utf8') <= MAX_INPUT_BYTES ? handle : null;
}

function parseArgs(args) {
  const values = { input: undefined, previous: undefined, help: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--input') values.input = args[++index];
    else if (args[index] === '--previous') values.previous = args[++index];
    else if (args[index] === '--help' || args[index] === '-h') values.help = true;
    else return undefined;
  }
  return values;
}

export const HELP = `explain-worker-preparation --input <facts.json> [--previous <facts.json>]

Explains one (or compares two) explicitly supplied preparation fact documents
offline using only accepted checkPrivateWorkerPreparationV1 output. Reads no
other files, starts no harness, and grants no execution authority. Malformed
input yields a generic refusal on stderr (exit 1) without echoing input.`;

async function explainDocument(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  let result;
  try {
    result = checkPrivateWorkerPreparationV1(value);
  } catch {
    return undefined;
  }
  return explainPreparation(result);
}

async function main(args) {
  const parsed = parseArgs(args);
  if (!parsed || parsed.help || !parsed.input) {
    if (parsed?.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    throw new Error('preparation_explain_usage');
  }
  const text = await readBounded(parsed.input);
  if (text === null) throw new Error('preparation_explain_unreadable');
  const current = await explainDocument(text);
  if (!current) throw new Error('preparation_explain_refused');
  const output = { explanation: current };
  if (parsed.previous) {
    const previousText = await readBounded(parsed.previous);
    if (previousText === null) throw new Error('preparation_explain_unreadable');
    const previous = await explainDocument(previousText);
    if (!previous) throw new Error('preparation_explain_refused');
    output.comparison = comparePreparations(previous, current);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error(GENERIC_REFUSAL);
    process.exitCode = 1;
  }
}

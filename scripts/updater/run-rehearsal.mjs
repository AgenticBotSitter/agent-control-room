#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readRehearsalConfigV1 } from "../../src/updater/v1/rehearsal/config.mjs";
import { runUpdaterRehearsalV1 } from "../../src/updater/v1/rehearsal/harness.mjs";

function configPath(args) {
  const index = args.indexOf("--config");
  if (index < 0 || !args[index + 1] || args.length !== 2) throw new Error("usage: run-rehearsal --config CONFIG.json");
  return args[index + 1];
}

export async function main(args = process.argv.slice(2)) {
  const config = await readRehearsalConfigV1(configPath(args));
  const result = await runUpdaterRehearsalV1(config, { onPhase: phase => {
    process.stderr.write(`${phase.id}\t${phase.status}\tpass=${phase.counts.pass}\tpending=${phase.counts.pending}\tfail=${phase.counts.fail}\n`);
  } });
  process.stdout.write(result.markdown);
  process.stdout.write(`\nEvidence: ${result.runRoot}\n`);
  return result.failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? "rehearsal_failed"}\n`); process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { DEFAULT_CONFIG_PATH, createTestRunnerService, readConfiguration } from "./service.mjs";

function configArgument(argv) {
  if (argv.length === 0) return DEFAULT_CONFIG_PATH;
  if (argv.length === 2 && argv[0] === "--config") return argv[1];
  throw new Error("usage: test-runner:serve [--config <absolute-path>]");
}

const config = await readConfiguration(configArgument(process.argv.slice(2)));
const service = await createTestRunnerService(config);
const address = await service.listen();
console.log(`test runner listening on 127.0.0.1:${address.port}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service.close();
}

process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

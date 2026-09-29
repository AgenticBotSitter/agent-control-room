#!/usr/bin/env node
import { readFile } from "node:fs/promises";

if (process.argv[2] === "--version") {
  process.stdout.write("Hermes Agent v0.21.3 (fixture) · upstream 00570550\n");
  process.exit(0);
}
const queryIndex = process.argv.indexOf("--query-file");
const queryPath = queryIndex >= 0 ? process.argv[queryIndex + 1] : undefined;
if (!queryPath) process.exit(2);
const query = await readFile(queryPath, "utf8");
const expected = /CONTROL_ROOM_HERMES_RUNNER_[a-f0-9]+/u.exec(query)?.[0];
if (!expected) process.exit(3);
process.stdout.write(`${JSON.stringify({ type: "result", session_id: "fixture:qualified", exit_code: 0,
  text: expected, tokens: { input: 14, output: 8, total: 22, cache_read: 0, cache_write: 0 },
  duration_ms: 25, timestamp: 1_750_000_000_000 })}\n`);

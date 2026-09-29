#!/usr/bin/env node
import { DEFAULT_CONFIG_PATH, readConfiguration, readExistingToken } from "./service.mjs";

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!["--config", "--worktree", "--file", "--script"].includes(name) || value === undefined) {
      throw new Error("usage: client.mjs [--config <path>] --worktree <path> (--file <test> | --script <name>)");
    }
    if (values[name] !== undefined) throw new Error(`duplicate argument: ${name}`);
    values[name] = value;
  }
  if (!values["--worktree"] || Boolean(values["--file"]) === Boolean(values["--script"])) {
    throw new Error("exactly one of --file or --script is required");
  }
  return values;
}

const args = argumentsFrom(process.argv.slice(2));
const config = await readConfiguration(args["--config"] ?? DEFAULT_CONFIG_PATH);
const token = await readExistingToken(config.tokenFile);
const body = { worktree: args["--worktree"], ...(args["--file"] ? { file: args["--file"] } : { script: args["--script"] }) };
let response;
try {
  response = await fetch(`http://127.0.0.1:${config.port}/v1/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (error) {
  console.error(`test runner request failed: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}
const result = await response.json().catch(() => ({ error: "invalid_response" }));
if (!response.ok) {
  console.error(`test runner refused the request (${response.status}): ${result.error ?? "unknown_error"}`);
  process.exitCode = 1;
} else {
  console.log(`run: ${result.runId}`);
  console.log(`command: ${result.command}`);
  console.log(`exit: ${result.exitCode ?? result.signal ?? "not_started"}${result.timedOut ? " (timed out)" : ""}`);
  console.log(`TAP: ${result.tap.pass} passed, ${result.tap.fail} failed, ${result.tap.tests} total`);
  if (result.tap.failingTests.length) console.log(`failing tests: ${result.tap.failingTests.join(", ")}`);
  if (result.outputTruncated) console.log(`log: capped excerpt from ${result.outputBytes} bytes`);
  if (result.logExcerpt) process.stdout.write(`${result.logExcerpt}${result.logExcerpt.endsWith("\n") ? "" : "\n"}`);
  if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.spawnError) process.exitCode = 1;
}

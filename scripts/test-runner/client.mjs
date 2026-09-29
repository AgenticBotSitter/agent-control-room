#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { DEFAULT_CONFIG_PATH, readConfiguration, readExistingToken } from "./service.mjs";

// Node's global `fetch` runs on undici, whose default `headersTimeout` is
// 300s — shorter than this service's own configurable run timeout (up to
// 60 minutes). A plain `node:http` request has no such default, so a long
// run cannot fail on the client side while the server is still working on it.
function requestRun(port, token, body) {
  return new Promise((resolveResult, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/v1/runs",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolveResult({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(payload);
  });
}

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
  response = await requestRun(config.port, token, body);
} catch (error) {
  console.error(`test runner request failed: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}
let result;
try { result = JSON.parse(response.text); } catch { result = { error: "invalid_response" }; }
if (response.status < 200 || response.status >= 300) {
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

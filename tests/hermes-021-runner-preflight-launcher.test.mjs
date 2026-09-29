import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (file, args) => new Promise(resolve => {
  const child = spawn(file, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("close", code => resolve({ code, stdout, stderr }));
});

test("runner preflight fails closed without disclosing private settings", async () => {
  const privateValues = ["/private/owner/hermes", "/private/owner/work", "owner-profile", "owner-model", "owner-provider"];
  const result = await run(process.execPath, ["--import", "tsx", "scripts/preflight-local-hermes-021-runner.ts", "--owner-attended",
    "--executable", privateValues[0], "--profile", privateValues[2], "--model", privateValues[3], "--provider", privateValues[4],
    "--workdir", privateValues[1]]);
  assert.equal(result.code, 1); assert.match(result.stdout, /owner_configuration_invalid/);
  for (const value of privateValues) assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

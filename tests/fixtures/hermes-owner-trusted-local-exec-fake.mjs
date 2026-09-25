import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
if (prompt === "hang") {
  spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  setInterval(() => {}, 1_000);
} else if (prompt === "wait") {
  setInterval(() => {}, 1_000);
} else if (prompt === "malformed") {
  process.stdout.write("not-json\n");
} else if (prompt === "nonzero") {
  process.exitCode = 7;
} else if (prompt === "leak") {
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  child.unref();
} else {
  const received = { args: process.argv.slice(2), env: Object.keys(process.env).sort(), prompt };
  process.stdout.write(`${JSON.stringify({ type: "result", session_id: "session:fake", exit_code: 0,
    text: JSON.stringify(received), tokens: { input: 2, output: 3, total: 5, cache_read: 0, cache_write: 0 }, duration_ms: 1, timestamp: 1 })}\n`);
}

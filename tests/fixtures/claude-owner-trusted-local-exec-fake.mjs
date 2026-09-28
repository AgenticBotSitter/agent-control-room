import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const session = "00000000-0000-4000-8000-000000000001";
if (prompt === "hang") {
  spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  setInterval(() => {}, 1_000);
} else if (prompt === "wait") {
  setInterval(() => {}, 1_000);
} else if (prompt === "malformed") {
  process.stdout.write("not-json\n");
} else if (prompt === "nonzero") {
  process.exitCode = 7;
} else if (prompt === "overflow") {
  process.stdout.write("x".repeat(9_000));
  process.stderr.write("x".repeat(9_000));
} else if (prompt === "default-overflow") {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`);
  for (let index = 0; index < 8; index++) {
    process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: session,
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(140_000) }] } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: session, result: "valid terminal result", usage: {} })}\n`);
} else if (prompt === "exit-on-overflow") {
  // Overflow the configured byte limit and exit in the same tick. The adapter detects the limit in
  // a `data` event and then signals the group; this process is already gone by then, so the signal
  // fails with ESRCH. That is the window where a stop must not be reported as cleanup uncertainty.
  process.stdout.write("x".repeat(40_000));
  process.exit(0);
} else if (prompt === "leak") {
  // The direct process exits, but its TERM-ignoring child stays in this
  // detached group unless the adapter explicitly cleans it up.
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  child.unref();
} else {
  const received = { args: process.argv.slice(2), env: Object.keys(process.env).sort(), prompt };
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: session, result: JSON.stringify(received), usage: {} })}\n`);
}

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
if (prompt === "hang") {
  spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  setInterval(() => {}, 1_000);
} else if (prompt === "malformed") {
  process.stdout.write("not-json\n");
} else if (prompt === "nonzero") {
  process.exitCode = 7;
} else {
  const received = { args: process.argv.slice(2), env: Object.keys(process.env).sort(), prompt };
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "reasoning" } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(received) } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 5 } })}\n`);
}

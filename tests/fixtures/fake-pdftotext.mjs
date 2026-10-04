import { spawn } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";

const inputPath = process.argv.at(-2);
const outputPath = process.argv.at(-1);
if (!inputPath || !outputPath) throw new Error("fake_pdftotext_arguments_invalid");
const source = await readFile(inputPath, "utf8");

function sentinelToken(prefix) {
  const token = source.slice(prefix.length).trim();
  if (!/^[a-z0-9-]{12,80}$/u.test(token)) throw new Error("fake_pdftotext_token_invalid");
  return token;
}

if (source.startsWith("HANG:")) {
  const token = sentinelToken("HANG:");
  spawn(process.execPath, ["-e", `setTimeout(()=>require('fs').writeFileSync('/tmp/${token}','leaked'),600);setInterval(()=>{},1000)`], {
    detached: false,
    env: {},
    stdio: "ignore",
  });
  setInterval(() => {}, 1_000);
} else if (source.startsWith("SLOW:")) {
  const token = sentinelToken("SLOW:");
  spawn(process.execPath, ["-e", `setTimeout(()=>require('fs').writeFileSync('/tmp/${token}','leaked'),600);setInterval(()=>{},1000)`], {
    detached: false,
    env: {},
    stdio: "ignore",
  });
  setInterval(() => {}, 1_000);
} else if (source === "FAIL") {
  process.exitCode = 9;
} else if (source === "BIG") {
  await writeFile(outputPath, "x".repeat(16 * 1024), { flag: "wx" });
} else if (source === "CHATTER") {
  process.stderr.write("x".repeat(64 * 1024));
} else if (source === "INVALID_OUTPUT") {
  await writeFile(outputPath, Buffer.from([0xc3, 0x28]), { flag: "wx" });
} else if (source === "SYMLINK_OUTPUT") {
  await symlink(inputPath, outputPath);
} else if (source === "BURN") {
  const allocation = Buffer.alloc(96 * 1024 * 1024, 1);
  setInterval(() => allocation.fill(1), 1_000);
} else if (source.startsWith("%PDF-")) {
  await writeFile(outputPath, `Extracted PDF text: ${source.slice(5).trim()}\n`, { flag: "wx" });
} else {
  process.exitCode = 8;
}

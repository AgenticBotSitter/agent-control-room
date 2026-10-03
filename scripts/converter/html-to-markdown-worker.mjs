import { readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { getHeapStatistics } from "node:v8";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

const MAX_ELEMENTS = 20_000;
// The ceiling this worker will accept from the flag the service passes it. The
// service derives its `--max-old-space-size` from the same number
// (TEXT_COPY_NODE_HEAP_MB in src/converter/v1/text-copy-service.ts) because the
// two must agree: the flag is not the heap limit, it is a floor of ~2x the
// value, and a flag above this ceiling made the worker refuse to start with
// `memory_limit_unenforced` on every single HTML conversion.
//
// 160 MiB is what `--max-old-space-size=64` actually yields on the deployed
// Node, and it is the same value the service's memoryBytes limit is measured
// against, so a worker that starts is a worker already inside its budget.
const MAX_HEAP_BYTES = 160 * 1024 * 1024;

function escapeMarkdown(value) {
  return value.replaceAll("\\", "\\\\").replace(/([`*_{}\[\]<>#+.!|~-])/gu, "\\$1");
}

function normalizedText(value) {
  return value
    .replaceAll("\u0000", "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map(line => line.replace(/[\t ]+/gu, " ").trim())
    .filter(Boolean)
    .map(escapeMarkdown)
    .join("\n\n");
}

async function proveNetworkDenied() {
  if (process.env.CONTROL_ROOM_NETWORK_DENIAL_PROBE === "test-bypass") return;
  if (process.env.CONTROL_ROOM_NETWORK_DENIAL_PROBE !== "required") throw new Error("network_probe_configuration_invalid");
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 9 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("network_probe_timeout")); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("network_policy_unenforced")); });
    socket.once("error", error => {
      clearTimeout(timer);
      if (error.code === "EPERM" || error.code === "EACCES") resolve();
      else reject(new Error("network_policy_unenforced"));
    });
  });
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) throw new Error("arguments_invalid");
  if (getHeapStatistics().heap_size_limit > MAX_HEAP_BYTES) throw new Error("memory_limit_unenforced");
  await proveNetworkDenied();
  let html;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(inputPath)); }
  catch { throw new Error("input_not_utf8"); }
  if (html.includes("\u0000")) throw new Error("input_not_utf8");
  let dom;
  try {
    dom = new JSDOM(html, {
      url: "https://converter.invalid/source",
      contentType: "text/html",
      virtualConsole: new VirtualConsole(),
    });
    const article = new Readability(dom.window.document, { maxElemsToParse: MAX_ELEMENTS }).parse();
    if (!article?.textContent?.trim()) throw new Error("html_has_no_readable_text");
    const title = article.title?.trim() ? `# ${escapeMarkdown(article.title.trim())}\n\n` : "";
    const markdown = `${title}${normalizedText(article.textContent)}\n`;
    await writeFile(outputPath, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } finally {
    dom?.window.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "conversion_failed"}\n`);
  process.exitCode = 1;
});

import { parseMacLocalWebHostArguments, startMacLocalTaskHost } from "./start-web-host.mjs";

async function main() {
  const parsed = parseMacLocalWebHostArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log("Usage: pnpm mac:tasks -- --owner-attended --protected-root ABSOLUTE_PATH");
    return;
  }
  const active = await startMacLocalTaskHost(parsed);
  console.log("Control Room local task host is running. Press Control-C to stop.");
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    try { await active.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

void main().catch(error => { console.error(`mac-local-task-host: ${error.message}`); process.exitCode = 1; });

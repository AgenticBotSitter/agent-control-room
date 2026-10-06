import { updaterRefuseV1 } from "../contracts.mjs";

const refuse = code => { throw updaterRefuseV1(code); };

export async function readCodeV1(terminal, runtime = {}) {
  if (!terminal || terminal.isTTY !== true || typeof terminal.write !== "function"
    || typeof terminal.readLine !== "function" || typeof terminal.setRawMode !== "function") {
    refuse("updater_passkey_code_terminal_required");
  }
  const signals = runtime.signals ?? process;
  const read = new AbortController();
  let interrupt;
  const interrupted = new Promise((_, reject) => { interrupt = () => {
    read.abort(); reject(updaterRefuseV1("updater_passkey_code_interrupted"));
  }; });
  signals.once("SIGINT", interrupt);
  const timer = setTimeout(() => {
    read.abort(); interrupt();
  }, runtime.timeoutMs ?? 300000);
  let raw = false;
  try {
    terminal.setRawMode(true); raw = true;
    terminal.write("Type the 6-character code shown on the registration page: ");
    const line = await Promise.race([Promise.resolve().then(() => terminal.readLine(read.signal)), interrupted]);
    if (typeof line !== "string" || line.includes("\u0003")) refuse("updater_passkey_code_interrupted");
    const code = line.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/u.test(code)) refuse("updater_passkey_code_refused");
    return code;
  } finally {
    clearTimeout(timer);
    read.abort();
    signals.removeListener("SIGINT", interrupt);
    if (raw) terminal.setRawMode(false);
    terminal.write("\n");
  }
}

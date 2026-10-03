import { readCodeV1 } from "../../src/updater/v1/terminal/read-code.mjs";
import { bufferedLineReaderV1 } from "../../src/updater/v1/cli.mjs";

const reader = bufferedLineReaderV1(process.stdin);
const terminal = { isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  write: value => process.stdout.write(value), readLine: () => reader.readLine(),
  setRawMode: value => process.stdin.setRawMode(value) };
try {
  if (process.argv[2] === "wrong-right") {
    try { await readCodeV1(terminal); } catch (error) { process.stdout.write(`WRONG:${error.code}\n`); }
    process.stdout.write(`RIGHT:${await readCodeV1(terminal)}\n`);
    process.stdout.write(`LATER:${await terminal.readLine()}\n`);
  } else {
    try { await readCodeV1(terminal); } catch (error) { process.stdout.write(`INTERRUPTED:${error.code}\n`); }
    process.stdout.write(`RAW_MODE:${process.stdin.isRaw}\n`);
  }
} finally { reader.close(); }

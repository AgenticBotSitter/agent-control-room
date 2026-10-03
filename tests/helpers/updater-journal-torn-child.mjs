import { open } from "node:fs/promises";
import { join } from "node:path";
import { FileStepJournalV1 } from "../../src/updater/v1/journal.mjs";

const [root, ordinal, round] = process.argv.slice(2);
// Direct child, no descendants. EOF exits even if the parent disappears.
process.stdin.resume(); process.stdin.once("end", () => process.exit(0));
const probe = await open(join(root, "updater-state/journal.jsonl"), "r");
const prototype = Object.getPrototypeOf(probe), writeFile = prototype.writeFile;
await probe.close();
prototype.writeFile = async function (line, ...args) {
  if (typeof line !== "string" || !line.includes('"control-room.updater-journal/v1"'))
    return writeFile.call(this, line, ...args);
  const bytes = Buffer.from(line), cut = 1 + Math.floor((bytes.length - 2) * Number(round) / 19);
  await this.write(bytes.subarray(0, cut));
  process.send("partial-write");
  await new Promise(() => {});
};
await new FileStepJournalV1(root, { ownerUid: process.getuid() }).done({ runId: "crash", ordinal: Number(ordinal),
  state: "staged", detail: { payload: "é完整".repeat(100) } });

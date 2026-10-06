import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileStepJournalV1, UpdaterModeV1 } from "../../src/updater/v1/runtime.mjs";
import { UpdaterRunnerV1 } from "../../src/updater/v1/runner.mjs";

const root = process.argv[2], killIndex = Number(process.argv[3] ?? 0);
if (!root || !Number.isInteger(killIndex) || killIndex < 0) throw new Error("rehearsal_worker_arguments_refused");
const storePath = join(root, "store.json"), effectsPath = join(root, "effects.json"), firedPath = join(root, "kill-fired");

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

class FileStore {
  async liveRun() { return (await readJson(storePath)).run; }
  async events() { return (await readJson(storePath)).events; }
  // The mirror row is written BY the transition (B4: the row and its journal
  // mirror move in one statement). Appended separately it modelled the old
  // two-statement contract, which left `events()` empty and gave every journal
  // intent/done line the same ordinal.
  async transition(_runId, lease, state, detail, options = {}) {
    const value = await readJson(storePath);
    if (value.run.lease_token !== lease) throw new Error("updater_run_lease_lost");
    value.run = { ...value.run, state, detail, finished_at: options.terminal ? new Date().toISOString() : null };
    if (!options.terminal && !value.events.some(row => row.state === state))
      value.events.push({ ordinal: value.events.length + 1, state, detail });
    await atomicJson(storePath, value); return value.run;
  }
}

class KillJournal {
  constructor() { this.delegate = new FileStepJournalV1(root); this.index = 0; }
  async hook(kind, value) {
    await this.delegate[kind](value); this.index += 1;
    if (this.index !== killIndex) return;
    try { await readFile(firedPath); return; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await writeFile(firedPath, `${kind}:${this.index}\n`, { flag: "wx", mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  }
  intent(value) { return this.hook("intent", value); }
  done(value) { return this.hook("done", value); }
}

async function effect(name) {
  const value = await readJson(effectsPath);
  value.attempts[name] = (value.attempts[name] ?? 0) + 1;
  if (!value.applied.includes(name)) value.applied.push(name);
  await atomicJson(effectsPath, value);
}
const effects = {
  precheck: async () => effect("precheck"), stage: async () => effect("stage"),
  quickBackup: async () => effect("quick_backup"), drain: async () => effect("drain"),
  switchPair: async () => effect("switch"), restart: async () => effect("restart"),
  health: async () => { await effect("health"); return true; },
  commitKnownGood: async () => effect("known_good"), rollback: async () => effect("rollback"),
  measure: async () => effect("measure"),
};
const runner = new UpdaterRunnerV1({ store: new FileStore(), effects, journal: new KillJournal(),
  mode: new UpdaterModeV1(), stateFiles: { leaseToken: "lease-one", readSelfUpdate: async () => "On\n",
    hasRescueMarker: async () => false }, referee: { async assertPlanAllowed() {} } });
const result = await runner.runOnce();
process.stdout.write(`${JSON.stringify(result)}\n`);

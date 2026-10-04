// Foreground, seeded regression lane: real parser exports with fake stores only.
import { readdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI = "1";
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const seed = Number(flag("seed", 20261002)), cases = Number(flag("cases", 1000));
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(cases) || cases < 1 || cases > 1_000_000) throw new Error("fuzz_options_invalid");
const only = flag("target", "").split(",").filter(Boolean);
let failed = false, targets = 0;
for (const entry of readdirSync(new URL("./targets/", import.meta.url)).filter(f => f.endsWith(".mjs")).sort()) {
  const file = new URL(`./targets/${entry}`, import.meta.url).href;
  const mod = await import(file);
  for (const target of mod.targets ?? [mod.target]) {
    if (only.length && !only.includes(target.name)) continue;
    targets++;
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { file, name: target.name, seed, cases }, execArgv: ["--import", "tsx"],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        const arm = ms => { clearTimeout(timer); timer = setTimeout(() => reject(new Error("fuzz_hard_timeout")), ms); };
        arm(30_000);
        worker.on("message", message => {
          if (message.type === "case") arm(target.name === "module-bundle" ? 1000 : 8000);
          if (message.type === "done") resolve(message);
        });
        worker.on("error", () => reject(new Error("fuzz_worker_failed")));
        worker.on("exit", () => reject(new Error("fuzz_worker_exited")));
      });
      const bad = result.failures.length > 0 || result.completed !== cases;
      failed ||= bad;
      console.log(`${target.name}: ${result.completed}/${cases}, slowest=${result.slowestMs}ms, failures=${JSON.stringify(result.failures)}, exoticCrashKinds=${JSON.stringify(result.exoticCrashKinds)}`);
    } catch (error) {
      failed = true;
      console.log(`${target.name}: ${error.message}`);
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
}
if (!targets) throw new Error("fuzz_target_unknown");
console.log(`fuzz: targets=${targets}, seed=${seed}, cases=${cases}, ${failed ? "FAIL" : "PASS"}`);
process.exitCode = failed ? 1 : 0;

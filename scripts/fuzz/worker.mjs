import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Rng } from "./lib/rng.mjs";
import { isF13ExoticCase, leaksInternals } from "./lib/harness.mjs";
const { file, name, seed, cases } = workerData;
const mod = await import(file);
const target = (mod.targets ?? [mod.target]).find(t => t.name === name);
const rng = new Rng(seed), failures = [], exoticCrashes = new Set();
const corpus = typeof target.corpus === "function" ? await target.corpus() : target.corpus ?? [];
let completed = 0, slowestMs = 0;
try {
  await target.setup?.();
  if (target.corpusMustPass !== false) for (let i = 0; i < corpus.length; i++) {
    const result = await target.invoke(target.corpusInput ? target.corpusInput(corpus[i]) : corpus[i]);
    if (result?.outcome !== "accepted") failures.push({ kind: "corpus_refused", index: i });
  }
  for (let i = 0; i < cases; i++) {
    const generated = target.generate(rng, corpus, i);
    const input = generated?.$input !== undefined ? generated.$input : generated;
    parentPort.postMessage({ type: "case", index: i });
    const start = performance.now();
    let result;
    try { result = await target.invoke(input, rng); }
    catch (error) {
      if (target.expectedErrors?.(error, input) === false) {
        if (isF13ExoticCase(name, input)) exoticCrashes.add(error?.name ?? typeof error);
        else failures.push({ kind: "unexpected_error", index: i });
      }
      if (target.leakCheck !== false && leaksInternals(error?.message)) failures.push({ kind: "leak", index: i });
      result = { outcome: "refused" };
    }
    // A thrown expected refusal has no return value for value-based oracles.
    if (result.value !== undefined || result.outcome === "accepted") {
      const verdict = await target.oracle?.(input, result, rng);
      if (verdict) failures.push({ kind: "bypass", index: i, verdict });
    }
    const ms = performance.now() - start;
    slowestMs = Math.max(slowestMs, ms);
    if (ms >= (name === "module-bundle" ? 1000 : 2000)) failures.push({ kind: "slow", index: i });
    completed++;
    if (failures.length >= 10) break;
  }
} finally { await target.teardown?.(); }
parentPort.postMessage({ type: "done", completed, slowestMs: Math.round(slowestMs), failures, exoticCrashKinds: [...exoticCrashes] });

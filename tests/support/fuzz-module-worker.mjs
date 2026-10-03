import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
const voice = workerData.kind === "voice";
const { targets } = await import(voice ? "../../scripts/fuzz/targets/09-voice-loopback-mcp.mjs" : "../../scripts/fuzz/targets/02-packs-modules.mjs");
const target = targets.find(t => t.name === (voice ? "voice:transcripts" : "module-bundle"));
const input = voice ? workerData.input : { bundle: structuredClone(target.corpus[0]), signature: null };
if (!voice) input.bundle.files = workerData;
parentPort.once("message", () => {
  const start = performance.now();
  try { const result = target.invoke(input); parentPort.postMessage({ accepted: true, value: result.value, ms: performance.now() - start }); }
  catch (error) { parentPort.postMessage({ error: error.message, ms: performance.now() - start }); }
});
parentPort.postMessage("ready");

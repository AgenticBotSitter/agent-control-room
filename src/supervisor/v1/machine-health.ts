import { execFile } from "node:child_process";
import { loadavg } from "node:os";

export const SUPERVISOR_MAX_SHARED_MEMORY_SEGMENTS_V1 = 31;
export const SUPERVISOR_MAX_LOAD_ONE_MINUTE_V1 = 17.999999;

export type SupervisorMachineSampleV1 = Readonly<{
  hostAlive: boolean;
  sharedMemorySegments: number | null;
  loadOneMinute: number | null;
}>;

export type SupervisorMachineHealthV1 = SupervisorMachineSampleV1 & Readonly<{
  loopAlive: boolean;
  healthy: boolean;
  reasonCodes: readonly ("host_not_alive" | "loop_not_alive" | "shared_memory_unavailable"
    | "shared_memory_limit" | "load_unavailable" | "load_limit")[];
}>;

export function countSharedMemorySegmentsV1(output: string): number {
  if (typeof output !== "string") throw new Error("supervisor_shared_memory_unavailable");
  return output.split(/\r?\n/u).map(line => line.trim()).filter(line =>
    /^m\s+\d+\s+/u.test(line) || /^0x[0-9a-f]+\s+\d+\s+/iu.test(line)).length;
}

export type SupervisorMachineProbeV1 = Readonly<{ sample(): Promise<SupervisorMachineSampleV1> }>;

type MachineRuntime = Readonly<{
  parentAlive(): boolean;
  loadOneMinute(): number;
  sharedMemory(): Promise<string>;
}>;

const productionRuntime: MachineRuntime = Object.freeze({
  parentAlive() {
    if (!Number.isSafeInteger(process.ppid) || process.ppid <= 1) return false;
    try { process.kill(process.ppid, 0); return true; } catch { return false; }
  },
  loadOneMinute: () => loadavg()[0] ?? Number.NaN,
  sharedMemory: () => new Promise<string>((resolve,reject) => execFile("/usr/bin/ipcs", ["-m"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 }, (error,stdout) => error ? reject(error) : resolve(stdout))),
});

export function createSupervisorMachineProbeV1(runtime: MachineRuntime = productionRuntime): SupervisorMachineProbeV1 {
  return Object.freeze({ async sample() {
    let segments: number | null = null;
    try { segments = countSharedMemorySegmentsV1(await runtime.sharedMemory()); } catch { /* unavailable is unhealthy */ }
    const load = runtime.loadOneMinute();
    return Object.freeze({ hostAlive: runtime.parentAlive(), sharedMemorySegments: segments,
      loadOneMinute: Number.isFinite(load) && load >= 0 ? load : null });
  } });
}

export function evaluateSupervisorMachineHealthV1(sample: SupervisorMachineSampleV1, loopAlive: boolean): SupervisorMachineHealthV1 {
  const reasonCodes: SupervisorMachineHealthV1["reasonCodes"][number][] = [];
  if (!sample.hostAlive) reasonCodes.push("host_not_alive");
  if (!loopAlive) reasonCodes.push("loop_not_alive");
  if (sample.sharedMemorySegments === null) reasonCodes.push("shared_memory_unavailable");
  else if (sample.sharedMemorySegments > SUPERVISOR_MAX_SHARED_MEMORY_SEGMENTS_V1) reasonCodes.push("shared_memory_limit");
  if (sample.loadOneMinute === null) reasonCodes.push("load_unavailable");
  else if (sample.loadOneMinute >= 18) reasonCodes.push("load_limit");
  return Object.freeze({ ...sample, loopAlive, healthy: reasonCodes.length === 0,
    reasonCodes: Object.freeze(reasonCodes) });
}

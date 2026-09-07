import assert from "node:assert/strict";
import test from "node:test";
import { launchContributorDemo } from "../src/contributor-demo/launcher.ts";

function fixture() {
  const signals = new Map<string, () => void>();
  const output: string[] = [], errors: string[] = [];
  let exitCode = 0, starts = 0, closes = 0;
  const io = { on: (s: string, f: () => void) => { signals.set(s, f); },
    off: (s: string) => { signals.delete(s); }, output: (m: string) => { output.push(m); },
    error: (m: string) => { errors.push(m); }, exitCode: (c: number) => { exitCode = c; } };
  const service = { ownerCode: "synthetic-secret", start: async () => { starts++; }, close: async () => { closes++; } };
  return { signals, output, errors, io, service, counts: () => ({ exitCode, starts, closes }) };
}
test("launcher prints code only after successful start and cleans on repeated signals", async () => {
  const f = fixture();
  await launchContributorDemo(async () => f.service, f.io);
  assert.match(f.output[0], /synthetic-secret/); assert.equal(f.counts().starts, 1);
  f.signals.get("SIGINT")!(); f.signals.get("SIGTERM")!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().closes, 1); assert.equal(f.signals.size, 0);
});
test("signal during preparation prevents start and code disclosure", async () => {
  const f = fixture();
  await launchContributorDemo(async () => { f.signals.get("SIGTERM")!(); return f.service; }, f.io);
  assert.deepEqual(f.counts(), { exitCode: 0, starts: 0, closes: 1 }); assert.deepEqual(f.output, []);
});
test("startup failure is sanitized, cleans up and does not retry", async () => {
  const f = fixture();
  await launchContributorDemo(async () => ({ ...f.service, start: async () => { throw new Error("private diagnostic"); } }), f.io);
  assert.equal(f.counts().exitCode, 1); assert.equal(f.counts().closes, 1);
  assert.deepEqual(f.output, []); assert.doesNotMatch(f.errors.join(""), /private diagnostic|synthetic-secret/);
  assert.equal(f.signals.size, 0);
});
test("signal during binding suppresses the login code even when start resolves late", async () => {
  const f = fixture();
  await launchContributorDemo(async () => ({ ...f.service, start: async () => { f.signals.get("SIGINT")!(); } }), f.io);
  assert.equal(f.counts().closes, 1); assert.equal(f.signals.size, 0);
  assert.deepEqual(f.output, []); assert.deepEqual(f.errors, []);
});
test("cleanup uncertainty is visible without raw diagnostics", async () => {
  const f = fixture();
  await launchContributorDemo(async () => ({ ...f.service, close: async () => { throw new Error("private path"); } }), f.io);
  f.signals.get("SIGINT")!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().exitCode, 1); assert.match(f.errors[0], /could not be confirmed/);
  assert.doesNotMatch(f.errors[0], /private path/); assert.equal(f.signals.size, 0);
});

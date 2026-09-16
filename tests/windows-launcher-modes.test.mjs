import assert from "node:assert/strict";
import test from "node:test";
import { decideLauncherMode, runLauncherModeCli, supportedLauncherModes, unsupportedLauncherModes } from "../scripts/windows/decide-launcher-mode.mjs";

test("supported launcher modes are accepted", () => {
  for (const mode of supportedLauncherModes) {
    const d = decideLauncherMode(mode);
    assert.equal(d.ok, true, `expected ok for ${mode}`);
    assert.equal(d.mode, mode);
  }
});

test("unsupported launcher modes are refused with the correct canonical reason", () => {
  const expectations = new Map([
    ["production-server", "unavailable_platform"],
    ["posix-vps-custody", "unavailable_platform"],
    ["live-harness-launch", "permission_denied"],
  ]);
  for (const mode of unsupportedLauncherModes) {
    const d = decideLauncherMode(mode);
    assert.equal(d.ok, false);
    assert.equal(d.reason, expectations.get(mode), `wrong reason for ${mode}`);
  }
});

test("unknown mode is refused as corrupt (canonical keyAvailabilityStates member)", () => {
  const d = decideLauncherMode("made-up-mode");
  assert.equal(d.ok, false);
  assert.equal(d.reason, "corrupt");
});

test("CLI: missing arg exits 3 (corrupt)", () => {
  const captured = captureStd(() => runLauncherModeCli([]));
  assert.equal(captured.exit, 3);
  assert.match(captured.stderr, /usage:/);
});

test("CLI: supported mode prints ok and exits 0 (available)", () => {
  const captured = captureStd(() => runLauncherModeCli(["contributor-demo"]));
  assert.equal(captured.exit, 0);
  assert.match(captured.stdout, /^ok: contributor-demo\n$/);
});

test("CLI: production-server refuses as unavailable_platform (exit 4)", () => {
  const captured = captureStd(() => runLauncherModeCli(["production-server"]));
  assert.equal(captured.exit, 4);
  assert.match(captured.stderr, /refused: production-server \(unavailable_platform\)/);
});

test("CLI: live-harness-launch refuses as permission_denied (exit 5)", () => {
  const captured = captureStd(() => runLauncherModeCli(["live-harness-launch"]));
  assert.equal(captured.exit, 5);
  assert.match(captured.stderr, /refused: live-harness-launch \(permission_denied\)/);
});

test("CLI: posix-vps-custody refuses as unavailable_platform (exit 4)", () => {
  const captured = captureStd(() => runLauncherModeCli(["posix-vps-custody"]));
  assert.equal(captured.exit, 4);
  assert.match(captured.stderr, /refused: posix-vps-custody \(unavailable_platform\)/);
});

test("CLI: unknown mode refuses as corrupt (exit 3)", () => {
  const captured = captureStd(() => runLauncherModeCli(["not-a-mode"]));
  assert.equal(captured.exit, 3);
  assert.match(captured.stderr, /refused: not-a-mode \(corrupt\)/);
});

/** Capture process.exit + stdout/stderr for a synchronous function. */
function captureStd(fn) {
  const origExit = process.exit;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  let exit = 0;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  process.exit = (code) => { exit = code ?? 0; throw new Error(`__exit_${exit}`); };
  try { fn(); } catch (e) { if (!String(e.message).startsWith("__exit_")) throw e; }
  finally {
    process.exit = origExit;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { exit, stdout: out, stderr: err };
}
